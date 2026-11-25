import type {
  TikTokMinisSDK,
  TikTokVePlayerConstructor,
} from "../platform/tiktok/types";
import { logClientEvent } from "../observability/clientLog";
import { platformErrorMessage } from "../platform/tiktok/errors";

// TikTokMinisPlayerAdapter 是业务层获取官方 Player 的唯一入口。
export interface TikTokMinisPlayerAdapter {
  // getConstructor 返回已缓存或新获取的官方 Player 构造器。
  getConstructor(): Promise<TikTokVePlayerConstructor>;
}

// OfficialTikTokMinisPlayerAdapter 缓存 TTMinis.getPlayer("byteplus") 的结果，
// 多个播放请求不会重复初始化 SDK。
export class OfficialTikTokMinisPlayerAdapter implements TikTokMinisPlayerAdapter {
  private constructorPromise?: Promise<TikTokVePlayerConstructor>;

  constructor(private readonly readSDK: () => TikTokMinisSDK | undefined) {}

  // getConstructor 在首次调用时固定请求 byteplus 通道，失败后允许重试。
  getConstructor(): Promise<TikTokVePlayerConstructor> {
    if (this.constructorPromise) return this.constructorPromise;
    const sdk = this.readSDK();
    if (!sdk?.getPlayer) {
      const error = new Error("TikTok Minis Player capability is unavailable");
      logClientEvent("error", "player_constructor_unavailable", {
        error: error.message,
      });
      return Promise.reject(error);
    }
    const startedAt = performance.now();
    logClientEvent("info", "player_constructor_requested", {
      flow: "official_playback",
      stage: "get_player",
      outcome: "started",
    });
    // 将桥接同步异常纳入同一拒绝与清理路径，下次用户重试仍可重新获取。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("TikTok Minis Player initialization timed out")), 15_000);
    });
    // 桥接无回调必须有界退出；迟到结果只能留在旧 race 中，不能覆盖下一次重试。
    const pending = Promise.race([Promise.resolve().then(() => sdk.getPlayer!("byteplus")), timeout]).then((constructor) => {
      if (typeof constructor !== "function") {
        throw new Error("TikTok Minis Player constructor is invalid");
      }
      logClientEvent("info", "player_constructor_ready", {
        flow: "official_playback",
        stage: "get_player",
        outcome: "success", elapsedMs: performance.now() - startedAt,
      });
      return constructor;
    }).catch((reason: unknown) => {
      if (this.constructorPromise === pending) this.constructorPromise = undefined;
      logClientEvent("error", "player_constructor_failed", {
        error: platformErrorMessage(reason, "TikTok Minis Player initialization failed"),
      });
      throw reason;
    }).finally(() => clearTimeout(timer));
    this.constructorPromise = pending;
    return this.constructorPromise;
  }
}

/** productionTikTokMinisPlayerAdapter 是本地与发布包共用的官方 SDK 适配器。 */
export const productionTikTokMinisPlayerAdapter =
  new OfficialTikTokMinisPlayerAdapter(() => window.TTMinis);
