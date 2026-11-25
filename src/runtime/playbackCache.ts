import type { PlayResolveResult } from "../domain/types";
import { identityChangedError } from "../api/httpMiniDramaApi";
import { remainingServerTime } from "../domain/serverTime";
import { timePolicy } from "../config/timePolicy";
import { logClientEvent } from "../observability/clientLog";

/** PlaybackCache 在当前 runtime 内共享短期授权和在途请求；不持久化观众权益。 */
export class PlaybackCache {
  private revision = 0;
  private identityRevision = 0;
  private entries = new Map<string, { startedAt: number; promise: Promise<PlayResolveResult>; result?: PlayResolveResult }>();

  /** seed 复用聚合接口已返回的目标集授权，使用相同的短期失效规则。 */
  seed(subject: string, dramaId: string, episodeId: string, result: PlayResolveResult): void {
    this.entries.set(JSON.stringify([subject, dramaId, episodeId]), {
      startedAt: performance.now(), promise: Promise.resolve(result), result,
    });
  }

  /** forget 在最新决策要求先完成门禁时撤销该集的早期预取许可。 */
  forget(subject: string, dramaId: string, episodeId: string): void {
    this.entries.delete(JSON.stringify([subject, dramaId, episodeId]));
  }

  private isExpired(entry: { startedAt: number; result?: PlayResolveResult }, now: number): boolean {
    const result = entry.result;
    const source = result?.status === "playable" ? result.playback
      : result && "entryPreview" in result ? result.entryPreview?.playback : undefined;
    return now - entry.startedAt >= timePolicy.playbackCacheMs ||
      (source?.provider === "byteplus_web" && (remainingServerTime(source) ?? 0) <= timePolicy.playbackRefreshAheadMs);
  }

  /** getPlayable 只同步返回当前主体已经确认且仍有效的正片授权。 */
  getPlayable(subject: string, dramaId: string, episodeId: string): PlayResolveResult | undefined {
    const entry = this.entries.get(JSON.stringify([subject, dramaId, episodeId]));
    if (entry?.result?.status === "playable" && !this.isExpired(entry, performance.now())) return entry.result;
  }

  /** resolve 将预取与进页请求合并，过期或失败后重新向 API 验权。 */
  resolve(subject: string, dramaId: string, episodeId: string, request: () => Promise<PlayResolveResult>): Promise<PlayResolveResult> {
    const key = JSON.stringify([subject, dramaId, episodeId]);
    const now = performance.now();
    for (const [id, entry] of this.entries) {
      if (this.isExpired(entry, now)) this.entries.delete(id);
    }
    const cached = this.entries.get(key);
    if (cached) return cached.promise;
    const revision = this.revision;
    const identityRevision = this.identityRevision;
    const promise = Promise.resolve().then(request).then(result => {
      // 真正换号必须拒绝旧请求；同账号权益刷新则合并到最新验权，不能误报会话变化。
      if (identityRevision !== this.identityRevision) throw identityChangedError();
      if (revision !== this.revision) return this.resolve(subject, dramaId, episodeId, request);
      const entry = this.entries.get(key);
      if (entry?.promise === promise) entry.result = result;
      return result;
    }).catch(error => {
      // 广告退出的前台信号会撤销旧时间基准，旧响应可能先在 API 校验处失败。
      // 同账号只读验权仍合并当前代次；真正换号绝不向原主体重新发起请求。
      if (identityRevision !== this.identityRevision) throw identityChangedError();
      if (revision !== this.revision) {
        logClientEvent("info", "playback_authorization_superseded", { dramaId, episodeId });
        return this.resolve(subject, dramaId, episodeId, request);
      }
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { startedAt: now, promise });
    return promise;
  }

  /** clear 撤销旧授权；identityChanged 为 false 时在途请求重新验权，默认拒绝旧身份结果。 */
  clear(identityChanged = true): void {
    this.revision += 1;
    if (identityChanged) this.identityRevision += 1;
    this.entries.clear();
  }
}
