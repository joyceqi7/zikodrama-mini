import type { TikTokVePlayerConstructor, TikTokVePlayerOptions } from "../platform/tiktok/types";
import type { TikTokMinisPlayerAdapter } from "./tiktokMinisPlayerAdapter";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

/** supportsMediaPreload 仅在容器提供 MSE/MMS 时开启官方 MP4 字节缓存。 */
export function supportsMediaPreload(): boolean {
  return typeof window !== "undefined" &&
    (typeof (window as Window & { ManagedMediaSource?: unknown }).ManagedMediaSource === "function" || typeof window.MediaSource === "function");
}

/** OfficialPreloader 串行管理官方全局预加载器，锁定媒资只下载、不授予播放权限。 */
export class OfficialPreloader {
  private revision = 0;
  private queue = Promise.resolve();
  private playerConstructor?: TikTokVePlayerConstructor;
  private prepared = false;
  private preparing?: Promise<void>;
  private scene?: 0 | 1;
  /** constructor 复用生产播放器构造器，不加载另一套 SDK。 */
  constructor(private readonly adapter: TikTokMinisPlayerAdapter) {}

  /** prepare 只准备全局能力，不切换场景或清空已提交的入口任务。 */
  async prepare(preparedConstructor?: TikTokVePlayerConstructor): Promise<void> {
    if (this.prepared) return;
    if (!this.preparing) {
      this.preparing = (async () => {
        const ctor = this.playerConstructor ??= preparedConstructor ?? await this.adapter.getConstructor();
        ctor.setMediaInfoCacheConfig?.({ enable: true, cacheType: "memory" });
        if (supportsMediaPreload() && ctor.prepare) await ctor.prepare({ strategies: { preload: { preloadMaxCacheCount: 5 } } });
        this.prepared = true;
      })().finally(() => { this.preparing = undefined; });
    }
    await this.preparing;
  }

  /** update 首页使用手动模式，播放页按官方 feed 默认窗口预加载五秒，字节缓存最多保留五段。 */
  update(sources: TikTokVePlayerOptions[], scene: 0 | 1, preparedConstructor?: TikTokVePlayerConstructor): Promise<void> {
    const revision = ++this.revision;
    logClientEvent("info", "media_preload_update_requested", { scene, sourceCount: sources.length });
    this.queue = this.queue.then(async () => {
      const startedAt = performance.now();
      const ctor = this.playerConstructor ??= preparedConstructor ?? await this.adapter.getConstructor();
      if (revision !== this.revision) return;
      ctor.setMediaInfoCacheConfig?.({ enable: true, cacheType: "memory" });
      const canPreload = supportsMediaPreload() && ctor.prepare && ctor.setPreloadScene && ctor.setPreloadList;
      if (canPreload) {
        await this.prepare(ctor);
        if (revision !== this.revision) return;
        // 官方自动模式会按播放位置串行调度。仅在首页与播放页切换时取消旧任务，
        // 同一场景更新有序列表不能中断正在下载的下一集。
        if (this.scene !== scene) {
          ctor.preloader?.clearPreloadList?.();
          ctor.preloader?.removeAllPreloadTask?.();
          await ctor.setPreloadScene!(scene, scene === 0 ? { preloadTime: 5 } : { prevCount: 1, nextCount: 2, preloadTime: 5 });
          this.scene = scene;
        }
        if (revision !== this.revision) return;
        // setPreloadList 自身会取媒体信息，不对相同资源紧接着重复 prefetch。
        logClientEvent("info", "media_preload_list_started", { scene, sourceCount: sources.length });
        await ctor.setPreloadList!(sources);
        logClientEvent("info", "media_preload_list_submitted", {
          scene, sourceCount: sources.length, elapsedMs: Math.max(0, performance.now() - startedAt),
        });
      } else if (ctor.prefetchMediaInfo) {
        const results = await ctor.prefetchMediaInfo(sources);
        logClientEvent("info", "media_preload_info_only", {
          scene, sourceCount: sources.length, elapsedMs: Math.max(0, performance.now() - startedAt),
        });
        if (results.some((item) => item.status !== "fulfilled")) {
          logClientEvent("warn", "media_prefetch_partial_failure", { error: "Some media information could not be prepared" });
        }
      }
    }).catch((error) => { logClientEvent("warn", "media_preload_failed", { error: safeErrorMessage(error) }); });
    return this.queue;
  }

  /** clear 取消旧候选和下载任务；purge 为 true 时同时释放媒体信息和字节，用于换身份或权益到期。 */
  clear(purge = false): void {
    ++this.revision;
    this.scene = undefined;
    this.queue = this.queue.then(() => {
      this.playerConstructor?.preloader?.clearPreloadList?.();
      this.playerConstructor?.preloader?.removeAllPreloadTask?.();
      if (purge) {
        this.playerConstructor?.preloader?.removeAll?.();
        this.playerConstructor?.clearMediaInfoCache?.();
      }
    }).catch((error) => { logClientEvent("warn", "media_preload_cleanup_failed", { error: safeErrorMessage(error) }); });
  }
}
