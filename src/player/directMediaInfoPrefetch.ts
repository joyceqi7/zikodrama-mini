import { timePolicy } from "../config/timePolicy";
import { remainingServerTime } from "../domain/serverTime";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import type { TikTokVePlayerConstructor, TikTokVePlayerOptions } from "../platform/tiktok/types";
import type { PlaybackSource } from "./playbackEngine";

/** isUsableDirectSource 只校验独立 SDK 所需的媒资身份和剩余授权时间。 */
export function isUsableDirectSource(source: PlaybackSource): source is PlaybackSource & { playAuthToken: string } {
  return source.provider === "byteplus_web" && !!source.vid && !!source.playAuthToken &&
    !source.albumId && !source.episodeId && Number.isFinite(Date.parse(source.expiresAt || "")) &&
    (remainingServerTime(source) ?? 0) > timePolicy.playbackRefreshAheadMs;
}

/** directMediaInfoOptions 让预取与实际播放使用相同的 Token 和媒体信息参数。 */
export function directMediaInfoOptions(source: PlaybackSource): Pick<TikTokVePlayerOptions, "vid" | "getVideoByToken"> {
  return { vid: source.vid, getVideoByToken: { playAuthToken: source.playAuthToken, needPoster: true } };
}

// 前台请求到达时只接续已明显领先的查询。截止点以预取发起时刻计算，快进或迟滞任务不增加等待。
const HANDOFF_MIN_LEAD_MS = 150;
const HANDOFF_MAX_WAIT_MS = 120;

interface PendingMediaInfo {
  promise: Promise<boolean>;
  startedAt?: number;
  yielded?: boolean;
}

/** DirectMediaInfoPrefetch 封装 SDK 的媒体信息内存缓存，调用方负责决定授权和页面时机。 */
export class DirectMediaInfoPrefetch {
  private sources = new WeakSet<PlaybackSource>();
  private readonly pending = new Map<string, PendingMediaInfo>();
  private lifetime = new AbortController();
  private clearing?: Promise<void>;

  /** constructor 只接收应用通道已经确认并完成初始化的 SDK 构造器。 */
  constructor(private readonly player: TikTokVePlayerConstructor) {}

  /** start 为已获授权且未过期的源排队预取，前台可以取消尚未发出的同源任务。 */
  start(source: PlaybackSource, stage: "launch" | "next_episode"): void {
    const player = this.player;
    const prefetch = player.prefetchMediaInfo;
    if (!prefetch || !player.clearMediaInfoCache || this.clearing ||
        this.sources.has(source) || !isUsableDirectSource(source)) return;
    const key = this.key(source);
    if (this.pending.has(key)) return;
    this.sources.add(source);
    const { signal } = this.lifetime;
    const fields = { vid: source.vid, stage };
    const task: PendingMediaInfo = {
      promise: Promise.resolve().then(async () => {
        if (signal.aborted || task.yielded || !isUsableDirectSource(source)) return false;
        const startedAt = task.startedAt = performance.now();
        logClientEvent("info", "direct_media_info_prefetch_started", fields);
        const [entry] = await prefetch.call(player, [directMediaInfoOptions(source)]);
        if (signal.aborted) return false;
        if (entry?.status !== "fulfilled") throw new Error(entry?.error?.message || "Media information prefetch failed");
        logClientEvent("info", "direct_media_info_prefetch_succeeded", { ...fields, elapsedMs: performance.now() - startedAt });
        return true;
      }).catch(reason => {
        if (!signal.aborted) {
          // SDK 有时把凭据拼进异常；只记录脱敏后的故障，实际播放仍走常规取流。
          const error = safeErrorMessage(reason).replaceAll(source.playAuthToken, "[REDACTED]");
          logClientEvent("warn", "direct_media_info_prefetch_failed", { ...fields, error });
        }
        return false;
      }),
    };
    this.pending.set(key, task);
    void task.promise.then(() => this.pending.delete(key));
  }

  /** take 让前台接管同份授权；只有在途查询已有提前量且未到截止点，才返回短暂的交接任务。 */
  take(source: PlaybackSource): Promise<void> | undefined {
    if (this.clearing || !isUsableDirectSource(source)) return;
    const task = this.pending.get(this.key(source));
    if (!task) return;
    if (task.startedAt === undefined) {
      task.yielded = true;
      return;
    }
    const requestedAt = performance.now();
    const age = requestedAt - task.startedAt;
    const budget = HANDOFF_MIN_LEAD_MS + HANDOFF_MAX_WAIT_MS - age;
    if (age < HANDOFF_MIN_LEAD_MS || budget <= 0) return;
    const { signal } = this.lifetime;
    return new Promise(resolve => {
      let finished = false;
      const finish = (outcome: string) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        signal.removeEventListener("abort", invalidate);
        logClientEvent("info", "direct_media_info_handoff", {
          vid: source.vid, outcome, elapsedMs: performance.now() - requestedAt,
        });
        resolve();
      };
      const invalidate = () => finish("invalidated");
      const timer = window.setTimeout(() => finish("timed_out"), budget);
      signal.addEventListener("abort", invalidate, { once: true });
      void task.promise.then(ready => finish(ready ? "cache_ready" : "fallback"));
    });
  }

  /** clear 释放等待中的前台并清理快照；旧 SDK 请求排空后再次清理，避免迟到结果写入旧权限。 */
  clear(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.sources = new WeakSet();
    this.clearCache();
    if (this.clearing || !this.pending.size) return;
    this.clearing = Promise.allSettled(Array.from(this.pending.values(), task => task.promise)).then(() => {
      this.clearCache();
      this.clearing = undefined;
    });
  }

  private key(source: PlaybackSource): string {
    // 实际挂载可能复制授权对象，用 VID 和原 Token 在内存中匹配，避免用上一份许可等待。
    return JSON.stringify([source.vid, source.playAuthToken]);
  }

  private clearCache(): void {
    try { this.player.clearMediaInfoCache?.(); }
    catch (reason) {
      logClientEvent("warn", "direct_media_info_clear_failed", { error: safeErrorMessage(reason) });
    }
  }
}
