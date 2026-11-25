import { vi } from "vitest";
import type { RewardedAdCloseResult, RewardedVideoAd, TikTokMinisSDK } from "../platform/tiktok/types";

/** createTikTokFixture 只供自动化测试控制官方回调；不会随运行页面加载。 */
export function createTikTokFixture() {
  let closeListeners = new Set<(result: RewardedAdCloseResult) => void>();
  const sdk: TikTokMinisSDK = {
    init: vi.fn(),
    canIUse: (capability) => ["login", "createRewardedVideoAd", "getSystemInfoSync"].includes(capability),
    login: vi.fn((options) => {
      if (typeof options === "function") options({ code: "test-login-code" });
      else options.success({ code: "test-login-code" });
    }),
    getSystemInfoSync: () => ({ language: "en", version: "99.0.0" }),
    createRewardedVideoAd: vi.fn((): RewardedVideoAd => {
      const listeners = new Set<(result: RewardedAdCloseResult) => void>();
      closeListeners = listeners;
      return {
        show: vi.fn(async () => undefined),
        onClose: (listener) => { listeners.add(listener); },
        offClose: (listener) => { listeners.delete(listener); },
        onError: vi.fn(), offError: vi.fn(),
      };
    }),
  };
  return {
    /** sdk 按官方接口响应登录，广告必须由测试明确触发关闭。 */
    sdk,
    /** closeRewardedAd 不依赖计时器；仅 isEnded 为 true 才可产生完成结果。 */
    closeRewardedAd(result: RewardedAdCloseResult) {
      if (!closeListeners.size) throw new Error("测试广告尚未注册关闭回调");
      [...closeListeners].forEach((listener) => listener(result));
    },
  };
}
