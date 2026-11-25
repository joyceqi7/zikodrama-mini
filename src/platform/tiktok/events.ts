import type { DramaDetail, DramaSummary } from "../../domain/types";
import { logClientEvent } from "../../observability/clientLog";
import { createMetricID, type TikTokPostbackEventName, type TikTokPostbackOutcome } from "../../observability/metrics";
import { platformErrorCodes, platformErrorMessage } from "./errors";
import { miniBuildVersion, type PostbackDetails, type PostbackScene } from "../../observability/postback";
import type { TikTokMinisSDK } from "./types";

/** PlaybackEventName 区分用户尝试播放与播放器实际开始播放，不由预加载触发。 */
export type PlaybackEventName = "video_play_request" | "ep_play";

/** TikTokPostbackRecord 关联 SDK 调用和脱敏参数快照，不证明平台入库。 */
export interface TikTokPostbackRecord {
  /** id 关联同一次回传的尝试和最终结果。 */
  id: string;
  /** event 是 TikTok 官方关键行为名。 */
  event: TikTokPostbackEventName;
  /** outcome 区分调用、接受、失败、未知和未调用。 */
  outcome: TikTokPostbackOutcome;
  /** occurredAt 固定业务事实时间，迟到回调和补报不改写日期。 */
  occurredAt: string;
  /** details 只包含白名单业务字段，平台身份已替换为固定占位符。 */
  details: PostbackDetails;
}

/** DramaEventContext 只保存当前请求或实际播放的业务剧目信息。 */
interface DramaEventContext {
  /** minis_drama_name 为业务侧剧名。 */
  minis_drama_name: string;
  /** minis_drama_id 为业务侧剧目 ID，保留字符串精度。 */
  minis_drama_id: string;
  /** episode_number 为发生该事实的集号，不是剧集 ID。 */
  episode_number: string;
  /** if_last_ep 表明该播放事实是否对应最后一集。 */
  if_last_ep: 0 | 1 | null;
}

/** TikTokEventReporter 回传官方 IAA 信号，失败只记录诊断，不改变观看和奖励结果。 */
export class TikTokEventReporter {
  private current?: DramaEventContext;
  private played?: DramaEventContext;
  private playedForRequest = false;
  private adDramas = new Set<string>();
  private dramas = new Map<string, Pick<DramaSummary, "id" | "title" | "episodeCount">>();
  private pending = new Set<() => void>();
  // 身份代次只在主体变化时递增；同主体刷新不能使正在展示的广告丢失上下文。
  private identityGeneration = 0;
  private identity = { openId: "", minisId: "", minisName: "" };

  /** constructor 延迟读取 SDK，便于启动桥接与本机替身测试。 */
  constructor(
    private readonly sdk: () => TikTokMinisSDK | undefined,
    private readonly record: (entry: TikTokPostbackRecord) => void = () => undefined,
  ) {}

  /** identify 绑定官方事件身份，切换用户或应用时清除旧上下文；标识不进入诊断日志。 */
  identify(openId: string, minisId: string, minisName: string): void {
    if (this.identity.openId !== openId || this.identity.minisId !== minisId) {
      for (const cancel of this.pending) cancel();
      this.pending.clear();
      this.clearPlaybackContext();
      this.dramas.clear();
      this.adDramas.clear();
      this.identityGeneration += 1;
    }
    this.identity = { openId, minisId, minisName };
  }

  /** rememberDrama 保存可信目录摘要，不制造播放请求；入剧广告可在播放器挂载前独立关联剧目。 */
  rememberDrama(drama: Pick<DramaSummary, "id" | "title" | "episodeCount">): void {
    if (this.dramas.size >= 100 && !this.dramas.has(drama.id)) this.dramas.delete(this.dramas.keys().next().value!);
    this.dramas.set(drama.id, { id: drama.id, title: drama.title, episodeCount: drama.episodeCount });
  }

  /** hasDrama 避免已有可信摘要时为广告再次加载目录。 */
  hasDrama(id: string): boolean { return this.dramas.has(id); }

  /** clearPlaybackContext 离开播放页时清理剧集事实，首页广告不能借用上一次观看的剧目。 */
  clearPlaybackContext(): void {
    this.current = this.played = undefined;
    this.playedForRequest = false;
  }

  /** playback 每次请求最多记录一次实际播放，恢复播放不会重复计数。 */
  playback(event: PlaybackEventName, drama: DramaDetail, episodeId: string): void {
    this.rememberDrama(drama);
    const index = drama.episodes.findIndex((episode) => episode.id === episodeId);
    const episode = drama.episodes[index];
    if (!episode) return;
    const context: DramaEventContext = {
      minis_drama_name: drama.title, minis_drama_id: drama.id,
      episode_number: String(episode.number),
      // 授权可只携带当前一集，只信任总集数；旧响应缺少总数时不猜测最后一集。
      if_last_ep: Number.isInteger(drama.episodeCount) && drama.episodeCount > 0
        ? (episode.number === drama.episodeCount ? 1 : 0) : null,
    };
    if (event === "video_play_request") {
      // 切剧后清除上一部剧的事实；即使之后切回，也不能认为还在原播放场景。
      if (this.current?.minis_drama_id !== drama.id) this.played = undefined;
      this.current = context;
      this.playedForRequest = false;
    } else {
      if (this.playedForRequest || this.current?.minis_drama_id !== drama.id || this.current.episode_number !== context.episode_number) return;
      this.playedForRequest = true;
      this.played = context;
    }
    this.send(event, { ...context }, "playback");
  }

  /** captureRewardedAd 固定广告发起时的身份与剧目，返回只能确认一次的展示回调。
   * dramaId 是剧集奖励绑定的业务剧目；未指定时使用当前播放场景，首页可以没有剧目信息。
   * contextReady 允许慢目录只延后官方回传，不阻塞广告展示、关闭或奖励结算。
   */
  captureRewardedAd(dramaId?: string, adType: "RewardedVideoAd" | "InterstitialAd" = "RewardedVideoAd", scene: PostbackScene = "episode_unlock",
    contextReady?: Promise<Pick<DramaSummary, "id" | "title"> | undefined>): () => void {
    const generation = this.identityGeneration;
    const identity = { ...this.identity };
    const context = !dramaId || this.current?.minis_drama_id === dramaId ? this.current : undefined;
    const summary = this.dramas.get(dramaId || context?.minis_drama_id || "");
    const targetDrama = dramaId || context?.minis_drama_id;
    const previous = targetDrama && this.played?.minis_drama_id === targetDrama ? this.played : undefined;
    let reported = false;
    return () => {
      if (reported) return;
      reported = true;
      const occurredAt = new Date().toISOString();
      const params: Record<string, string | number | null> = {
        ...(targetDrama ? { minis_drama_id: targetDrama } : {}),
        ...(summary?.title || context?.minis_drama_name ? { minis_drama_name: summary?.title || context!.minis_drama_name } : {}),
        ...(previous ? { episode_number: previous.episode_number } : {}),
        if_last_ep: previous?.if_last_ep ?? null,
        minis_name: identity.minisName, minis_id: identity.minisId,
        open_id: identity.openId, ad_type: adType,
      };
      if (generation !== this.identityGeneration) {
        this.send("minis_ad_show", params, scene, "identity_changed");
        logClientEvent("warn", "ad_event_identity_changed", { error: "Ad event skipped after viewer identity changed" });
        return;
      }
      if (!identity.openId || !identity.minisId) {
        this.send("minis_ad_show", params, scene, "identity_missing");
        logClientEvent("warn", "ad_event_identity_missing", { error: "Ad event requires the current official identity" });
        return;
      }
      const first = targetDrama ? !this.adDramas.has(targetDrama) : null;
      if (targetDrama) this.adDramas.add(targetDrama);
      // 首次标记沿用同一次 Mini 运行会话，不把文档未定义的范围扩展为用户终身首次。
      // 无上一集时保留缺失并在诊断中说明，不用解锁目标集或虚构集号填充。
      const report = (detail?: Pick<DramaSummary, "id" | "title">) => {
        // 只补原剧目的剧名；等待期间换号不能调用 SDK，也不能写入新主体的采集队列。
        if (generation !== this.identityGeneration) {
          logClientEvent("warn", "ad_event_identity_changed", { error: "Ad event skipped after viewer identity changed" });
          return;
        }
        if (!params.minis_drama_name && detail && detail.id === targetDrama && detail.title) params.minis_drama_name = detail.title;
        this.send("minis_ad_show", { ...params, if_first_time: first === null ? null : first ? 1 : 0 }, scene, undefined, occurredAt);
      };
      // 目录请求沿用 API 的超时边界，广告事实时间与首次标记仍固定在展示成功时。
      if (targetDrama && !params.minis_drama_name && contextReady) {
        void contextReady.then(report, reason => {
          logClientEvent("warn", "ad_drama_context_failed", { error: platformErrorMessage(reason, "Ad drama context unavailable") });
          report();
        });
      } else report();
    };
  }

  /** rewardedAdShown 供已确认展示的同步调用方使用；异步广告应提前 captureRewardedAd。 */
  rewardedAdShown(): void {
    this.captureRewardedAd()();
  }

  /** send 固定参数快照、事实时间和身份；仅 SDK 回调成功计调用成功，不自动重试官方事件。 */
  private send(eventName: TikTokPostbackEventName, params: Record<string, string | number | null>, scene: PostbackScene, skipReason?: string,
    occurredAt = new Date().toISOString()): void {
    const id = createMetricID();
    const generation = this.identityGeneration;
    const snapshot = { ...params };
    const redacted = { ...snapshot, ...("open_id" in snapshot ? { open_id: snapshot.open_id ? "[REDACTED]" : "" } : {}) };
    const warnings: string[] = [];
    if (!snapshot.minis_drama_id || !snapshot.minis_drama_name) warnings.push("missing_drama_context");
    if (eventName === "minis_ad_show" && !("episode_number" in snapshot)) warnings.push("missing_previous_episode");
    if (snapshot.if_last_ep === null) warnings.push("unknown_last_episode");
    const base: PostbackDetails = { scene, clientVersion: miniBuildVersion(), params: redacted, warnings };
    const started = performance.now();
    const audit = (outcome: TikTokPostbackOutcome, extra: Partial<PostbackDetails> = {}) => {
      // 换号后跳过的旧事实只留脱敏控制台日志，不能归入新账号的采集队列。
      if (generation !== this.identityGeneration || skipReason === "identity_changed") return;
      try { this.record({ id, event: eventName, outcome, occurredAt, details: { ...base, ...extra } }); }
      catch (reason) {
        logClientEvent("warn", "tiktok_event_record_failed", { flow: "tiktok_event_postback", stage: eventName, outcome,
          error: platformErrorMessage(reason, "Event record failed") });
      }
    };
    if (skipReason) { audit("skipped", { reason: skipReason }); return; }
    let answered = false;
    let invoked = false;
    let timer: number | undefined;
    const cancel = () => { window.clearTimeout(timer); answered = true; };
    const finish = (outcome: "success" | "failure", reason?: unknown, failureReason = "sdk_rejected") => {
      if (answered) return;
      answered = true; window.clearTimeout(timer); this.pending.delete(cancel);
      const elapsedMs = Math.min(86_400_000, Math.max(0, performance.now() - started));
      const extra: Partial<PostbackDetails> = { elapsedMs };
      if (outcome === "failure") Object.assign(extra, { reason: failureReason, ...platformErrorCodes(reason),
        errorMessage: platformErrorMessage(reason, "Event reporting was rejected").replaceAll(this.identity.openId || "\u0000", "[REDACTED]").slice(0, 512) });
      audit(outcome, extra);
      logClientEvent(outcome === "success" ? "info" : "error", outcome === "success" ? "tiktok_event_succeeded" : "tiktok_event_failed", {
        flow: "tiktok_event_postback", stage: eventName, outcome: outcome === "success" ? "sdk_accepted" : "rejected", elapsedMs,
        ...(extra.errorMessage ? { error: extra.errorMessage } : {}),
      });
    };
    try {
      const sdk = this.sdk();
      if (!sdk?.canIUse?.("reportEvent") || !sdk.reportEvent) {
        audit("skipped", { reason: "unsupported" });
        logClientEvent("warn", "tiktok_event_unsupported", { flow: "tiktok_event_postback", stage: eventName, outcome: "unsupported",
          error: `Event ${eventName} reporting is unavailable` });
        return;
      }
      invoked = true;
      audit("attempt");
      logClientEvent("info", "tiktok_event_requested", { flow: "tiktok_event_postback", stage: eventName, outcome: "attempt" });
      if (this.pending.size >= 200) { const oldest = this.pending.values().next().value; if (oldest) { oldest(); this.pending.delete(oldest); } }
      this.pending.add(cancel);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (answered) return;
        audit("unknown", { reason: "callback_timeout", elapsedMs: Math.min(86_400_000, Math.max(0, performance.now() - started)) });
        logClientEvent("warn", "tiktok_event_callback_missing", { flow: "tiktok_event_postback", stage: eventName, outcome: "unknown" });
        // 超时仍允许迟到回调补充结果；窗口有界，不能无限保留已退出页面的闭包。
        timer = window.setTimeout(() => { cancel(); this.pending.delete(cancel); }, 300_000);
      }, 10_000);
      sdk.reportEvent({ eventName, params: snapshot, callback: result => finish(result?.isSuccess === true ? "success" : "failure", result) });
    } catch (reason) {
      // SDK 获取或能力探测异常时也记录实际失败，成功回调后抛错不能再覆盖成功。
      if (answered) return;
      if (!invoked) {
        const errorMessage = platformErrorMessage(reason, "SDK unavailable").replaceAll(this.identity.openId || "\u0000", "[REDACTED]").slice(0, 512);
        audit("skipped", { reason: "exception", ...platformErrorCodes(reason), errorMessage });
        logClientEvent("error", "tiktok_event_capability_failed", { flow: "tiktok_event_postback", stage: eventName, outcome: "skipped", error: errorMessage });
      } else finish("failure", reason, "exception");
    }
  }
}
