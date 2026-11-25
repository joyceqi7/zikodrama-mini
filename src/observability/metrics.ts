import { logClientEvent, safeErrorMessage } from "./clientLog";
import type { AdMetricDetails, AdMetricKind, AdObservation, AdObserver, AdTimeline } from "./adMetrics";
import type { PostbackDetails } from "./postback";

/** TikTokPostbackEventName 是当前短剧 IAA 向 TikTok 回传的关键行为。 */
export type TikTokPostbackEventName = "video_play_request" | "ep_play" | "minis_ad_show";

/** TikTokPostbackOutcome 只描述 SDK 调用结果，不代表 TikTok 服务端入库或归因。 */
export type TikTokPostbackOutcome = "attempt" | "success" | "failure" | "unknown" | "skipped";

/** MetricKind 只描述统计事实，不含播放位置、剧目或广告凭据。 */
export type MetricKind = AdMetricKind
  | "active" | "launch" | "play_start" | "play_complete"
  | "rewarded_show" | "rewarded_complete" | "interstitial_show"
  | "player_first_frame" | "player_switch" | "player_stall" | "player_autoplay_blocked" | "player_error"
  | "tt_video_request_attempt" | "tt_video_request_success" | "tt_video_request_failure"
  | "tt_episode_play_attempt" | "tt_episode_play_success" | "tt_episode_play_failure"
  | "tt_ad_show_attempt" | "tt_ad_show_success" | "tt_ad_show_failure"
  | "tt_video_request_unknown" | "tt_episode_play_unknown" | "tt_ad_show_unknown"
  | "tt_video_request_skipped" | "tt_episode_play_skipped" | "tt_ad_show_skipped";

/** MetricEvent 在重试中保持同一 ID 和观察时间。 */
export interface MetricEvent {
  /** id 是本次事实的随机去重键。 */
  id: string;
  /** kind 是服务端允许的统计类型。 */
  kind: MetricKind;
  /** occurredAt 使用 UTC 时间，服务端限制可接受的时间窗口。 */
  occurredAt: string;
  /** postback 是可选诊断快照；旧客户端继续只发送计数，身份由认证接口确认。 */
  postback?: PostbackDetails;
  /** ad 是可选广告调用诊断；不参与领奖判定。 */
  ad?: AdMetricDetails;
  /** adTimeline 随现有阶段上报有界时序，只进入服务端日志。 */
  adTimeline?: AdTimeline;
}

/** MetricCollector 以有限内存队列异步上报，失败不影响观看或奖励；刷新页面可能丢失未确认信号。 */
export class MetricCollector {
  private subject = "";
  private generation = 0;
  private adTimelineScope = {};
  private queue: MetricEvent[] = [];
  private timer?: number;
  private activeDay = "";
  private visible = true;
  private sending = false;
  private failures = 0;
  private playback?: { key: string; id: string; started: boolean; completed: boolean };
  private postbacks = new Map<string, number>();
  private readonly heartbeat: number;
  private readonly visibility = () => this.active();

  /** constructor 使用真实 API 发送批量事实；测试可注入替身。 */
  constructor(private readonly send: (events: MetricEvent[]) => Promise<unknown>) {
    document.addEventListener("visibilitychange", this.visibility);
    this.heartbeat = window.setInterval(() => this.active(), 60_000);
  }

  /** identify 仅在完整身份安装后调用；切换主体时丢弃旧队列，不把旧事实归给新用户。 */
  identify(subject: string): void {
    if (subject === this.subject) return;
    this.subject = subject; this.generation++; this.adTimelineScope = {}; this.queue = []; this.failures = 0;
    this.playback = undefined; this.postbacks.clear(); this.activeDay = "";
    window.clearTimeout(this.timer); this.timer = undefined;
    if (subject) { this.emit("launch"); this.active(); }
  }

  /** setVisible 合并官方 Minis 前后台事实；原生隐藏但网页未隐藏时不能继续计活跃。 */
  setVisible(visible: boolean): void { this.visible = visible; if (visible) this.active(); }

  /** active 每个前台 UTC 日期最多发送一个活跃信号；跨日常驻页面仍会计入新一天。 */
  active(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.subject || !this.visible || document.visibilityState === "hidden" || this.activeDay === day) return;
    this.activeDay = day; this.emit("active");
  }

  /** playbackEvent 同一次切集只计一次实际开始和结束，暂停恢复不重复开始。 */
  playbackEvent(event: "request" | "start" | "complete", key: string): void {
    if (!this.subject) return;
    if (event === "request") { this.playback = { key, id: createMetricID(), started: false, completed: false }; return; }
    const current = this.playback;
    if (!current || current.key !== key) return;
    if (event === "start") {
      if (current.completed) { current.id = createMetricID(); current.started = false; current.completed = false; }
      if (!current.started) { current.started = true; this.emit("play_start", current.id); }
    } else if (current.started && !current.completed) { current.completed = true; this.emit("play_complete", current.id); }
  }

  /** clearPlayback 离开页面时清理内存上下文，服务端始终不接收剧目键。 */
  clearPlayback(): void { this.playback = undefined; }

  /** recordQuality 持久化脱敏播放器质量事实；耗时细节继续由白名单客户端日志记录。 */
  recordQuality(kind: Extract<MetricKind, `player_${string}`>): void { this.emit(kind); }

  /** capture 固定广告发起主体；每个回调只能确认一次，不把迟到事实写给新账号。 */
  capture(kind: MetricKind, id: string = createMetricID()): () => void {
    const generation = this.generation;
    let done = false;
    return () => { if (done) return; done = true; if (generation === this.generation) this.emit(kind, id); };
  }

  /** recordTikTokPostback 以同一事实键记录尝试及结果，便于识别未收到平台回调的回传。 */
  recordTikTokPostback(id: string, event: TikTokPostbackEventName, outcome: TikTokPostbackOutcome, postback?: PostbackDetails, occurredAt?: string): void {
    const prefix: Record<TikTokPostbackEventName, "tt_video_request" | "tt_episode_play" | "tt_ad_show"> = {
      video_play_request: "tt_video_request",
      ep_play: "tt_episode_play",
      minis_ad_show: "tt_ad_show",
    };
    if (outcome === "attempt") {
      if (this.postbacks.size >= 200) {
        const oldest = this.postbacks.keys().next().value as string | undefined;
        if (oldest) this.postbacks.delete(oldest);
      }
      this.postbacks.set(id, this.generation);
    } else if (outcome !== "skipped") {
      if (this.postbacks.get(id) !== this.generation) return;
      // 超时不是官方失败；保留关联键，让迟到回调能补充真实 SDK 结果。
      if (outcome !== "unknown") this.postbacks.delete(id);
    }
    this.emit(`${prefix[event]}_${outcome}` as MetricKind, id, postback, occurredAt);
  }

  /** captureAd 固定发起时的主体、事实 ID 和时间，重试及迟到回调不新增调用。 */
  captureAd(metadata: Omit<AdMetricDetails, keyof AdObservation>, id = createMetricID()): AdObserver {
    const generation = this.generation;
    const occurredAt = new Date().toISOString();
    const seen = new Set<AdMetricKind>();
    const observer: AdObserver = observation => {
      if (generation !== this.generation || seen.has(observation.kind)) return;
      seen.add(observation.kind);
      const { kind, failure: _failure, timeline, ...phase } = observation;
      this.emit(kind, id, undefined, occurredAt, { ...metadata, ...phase }, timeline);
    };
    return Object.assign(observer, { attemptId: id, timelineScope: this.adTimelineScope });
  }

  private emit(kind: MetricKind, id: string = createMetricID(), postback?: PostbackDetails, occurredAt = new Date().toISOString(), ad?: AdMetricDetails, adTimeline?: AdTimeline): void {
    if (!this.subject) return;
    if (this.queue.length >= 200) {
      logClientEvent("warn", "metrics_queue_full", { error: "Metric signal dropped because the pending queue is full" });
      return;
    }
    this.queue.push({ id, kind, occurredAt, ...(ad ? { ad: { ...ad } } : {}), ...(adTimeline ? { adTimeline } : {}),
      ...(postback ? { postback: { ...postback, params: { ...postback.params }, warnings: [...postback.warnings] } } : {}) });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.sending || !this.queue.length) return;
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush(); }, this.failures ? 5000 : 1000);
  }

  /** flush 仅重试当前主体的原始事件，三次失败后丢弃该批并记录诊断。 */
  async flush(): Promise<void> {
    if (this.sending || !this.subject || !this.queue.length) return;
    const generation = this.generation;
    const batch = this.queue.slice(0, 50);
    this.sending = true;
    try {
      await this.send(batch);
      if (generation === this.generation) { this.queue.splice(0, batch.length); this.failures = 0; }
    } catch (error) {
      logClientEvent("warn", "metrics_batch_failed", { error: safeErrorMessage(error) });
      if (generation === this.generation && ++this.failures >= 3) {
        this.queue.splice(0, batch.length); this.failures = 0;
        logClientEvent("warn", "metrics_batch_dropped", { error: "Metric batch exhausted its retry limit" });
      }
    } finally { this.sending = false; this.schedule(); }
  }

  /** dispose 清理计时器和前台监听，不承诺页面退出后继续上报。 */
  dispose(): void {
    this.identify(""); window.clearInterval(this.heartbeat);
    document.removeEventListener("visibilitychange", this.visibility);
  }
}

let fallbackSequence = 0;
/** createMetricID 生成计数去重键；随机能力异常时降级，采集不得阻塞业务。 */
export function createMetricID(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    logClientEvent("warn", "metrics_random_unavailable", { error: safeErrorMessage(error) });
    return `metric_${Date.now()}_${++fallbackSequence}_${Math.random().toString(36).slice(2)}`;
  }
}
