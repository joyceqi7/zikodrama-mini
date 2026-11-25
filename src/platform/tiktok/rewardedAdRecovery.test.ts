import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adPolicy } from "../../config/adPolicy";
import type { AdObserver } from "../../observability/adMetrics";
import { captureAdIntent } from "./adIntent";
import { hasPendingFullscreenAd, showFullscreenAd } from "./fullscreenAd";
import { disposeVisibilityTracking } from "./lifecycle";
import { showRewardedAd } from "./rewardedAd";
import type { RewardedAdCloseResult, TikTokMinisSDK } from "./types";

beforeEach(() => {
  vi.useFakeTimers();
  disposeVisibilityTracking();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  disposeVisibilityTracking();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 每个实例单独控制 show Promise 与回调，验证失败旧实例不能干扰恢复实例。
function nativeAds() {
  const ads: Array<{ shown(): void; reject(reason: unknown): void; error(reason: unknown): void; close(ended?: boolean): void }> = [];
  const create = vi.fn(() => {
    let close!: (result: RewardedAdCloseResult) => void;
    let error!: (reason: unknown) => void;
    let shown!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, fail) => { shown = resolve; reject = fail; });
    ads.push({ shown, reject, error: reason => error(reason), close: (isEnded = false) => close({ isEnded }) });
    return { show: () => promise, onClose: (fn: typeof close) => { close = fn; }, onError: (fn: typeof error) => { error = fn; }, offClose: vi.fn(), offError: vi.fn() };
  });
  return { ads, create, sdk: { canIUse: () => true, createRewardedVideoAd: create } as unknown as TikTokMinisSDK };
}

it.each(["50008", "11006"])("%s 明确未展示后等待再恢复，保留自动意图且不提前暴露错误，旧回调不能发奖", async code => {
  const h = nativeAds();
  const shown = vi.fn();
  const late = vi.fn();
  const next = Object.assign(vi.fn(), { attemptId: "retry-attempt" });
  const observe: AdObserver = Object.assign(vi.fn(), { attemptId: "first-attempt", nextAttempt: vi.fn(() => next) });
  const settled = vi.fn();
  const result = showRewardedAd(h.sdk, "slot", shown, late, observe).then(value => { settled(value); return value; });
  h.ads[0].error({ subErrorCode: code, errMsg: "host unavailable token=private-value" });
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedRecoveryDelayMs - 1);
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  expect(shown).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(observe.nextAttempt).toHaveBeenCalledOnce();
  h.ads[0].close(true);
  h.ads[0].shown();
  await Promise.resolve();
  expect(shown).not.toHaveBeenCalled();
  expect(late).not.toHaveBeenCalled();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.ads[1].shown();
  await Promise.resolve();
  h.ads[1].close(true);
  await expect(result).resolves.toEqual({ status: "completed" });
  expect(shown).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_request", timeline: expect.objectContaining({ request: expect.objectContaining({ userInitiated: false }) }) }));
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("host unavailable");
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-value");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["50008", "11006"])("%s 创建时明确拒绝也仅静默恢复一次，耗尽后停止且保留诊断", async errorCode => {
  const h = nativeAds();
  h.create.mockImplementation(() => { throw { subErrorCode: errorCode, errMsg: "native create rejected" }; });
  const observe = vi.fn();
  const result = showRewardedAd(h.sdk, "slot", undefined, undefined, observe);
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedRecoveryDelayMs);
  await expect(result).resolves.toMatchObject({ status: "failed", retryable: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_recovery_exhausted" }));
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_create_failed", error: "native create rejected" }));
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", stage: "create",
    reason: errorCode === "50008" ? "container_unavailable" : "ad_active_conflict" }));
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it.each(["50008", "11006"])("%s 展示已经确认时不重试，原生关闭前保持互斥，迟到完播只回原请求", async errorCode => {
  const h = nativeAds();
  const late = vi.fn();
  const result = showRewardedAd(h.sdk, "slot", undefined, late);
  h.ads[0].shown();
  await Promise.resolve();
  h.ads[0].error({ subErrorCode: errorCode });
  await expect(result).resolves.toMatchObject({ status: "failed" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.create).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.ads[0].close(true);
  expect(late).toHaveBeenCalledOnce();
});

it.each(["后台", "路由离开", "主体切换", "Offer 失效"])("静默等待遇到%s立即停止，恢复前台也不续用旧意图", async condition => {
  const h = nativeAds();
  let current = true;
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const result = showRewardedAd(h.sdk, "slot", undefined, undefined, undefined, captureAdIntent(() => current));
  h.ads[0].reject({ subErrorCode: "50008" });
  await vi.advanceTimersByTimeAsync(100);
  if (condition === "后台") {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  } else current = false;
  await vi.advanceTimersByTimeAsync(adPolicy.nativeAdRecoveryCheckMs);
  await expect(result).resolves.toMatchObject({ status: "failed", reason: condition === "后台" ? "not_visible" : "stale_intent" });
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.create).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("展示结果未知不重试，明确恢复等待期间若出现其他原生广告也不得重入", async () => {
  const h = nativeAds();
  const result = showRewardedAd(h.sdk, "slot");
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
  await expect(result).resolves.toEqual({ status: "unknown" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.create).toHaveBeenCalledOnce();
  h.ads[0].close();

  const recovering = showRewardedAd(h.sdk, "slot");
  h.ads[1].reject({ subErrorCode: "50008" });
  await vi.advanceTimersByTimeAsync(0);
  // 模拟其他手动入口在等待期间率先持有原生锁，恢复不得释放它或再创建广告。
  const other = showFullscreenAd(h.sdk, "other", "rewarded", undefined, undefined, undefined, captureAdIntent(() => true, true));
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedRecoveryDelayMs);
  await expect(recovering).resolves.toEqual({ status: "unknown" });
  expect(h.create).toHaveBeenCalledTimes(3);
  h.ads[2].close();
  await other;
});

it.each(["50010", "30001"])("普通 SDK 错误 %s 不进入静默恢复", async errorCode => {
  const h = nativeAds();
  const result = showRewardedAd(h.sdk, "slot");
  h.ads[0].reject({ errorCode });
  await result;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.create).toHaveBeenCalledOnce();
  expect(console.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_recovery_waiting" }));
});

it.each(["show", "callback"] as const)("50010 由 %s 拒绝时等待新前台，重复 show 或手动点击都不重拉", async source => {
  const h = nativeAds();
  const shown = vi.fn();
  const late = vi.fn();
  const observe = vi.fn();
  const first = showRewardedAd(h.sdk, "slot", shown, late, observe);
  const rejection = { errorCode: "101150000", subErrorCode: "50010", errMsg: "Mini is not in the foreground token=credential" };
  if (source === "show") h.ads[0].reject(rejection);
  else h.ads[0].error(rejection);
  await expect(first).resolves.toMatchObject({ status: "failed", reason: "not_visible" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", errorCode: "101150000", subErrorCode: "50010" }));
  h.ads[0].close(true);
  expect(shown).not.toHaveBeenCalled();
  expect(late).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(showRewardedAd(h.sdk, "slot", undefined, undefined, undefined, captureAdIntent(() => true, true))).resolves.toEqual({ status: "failed", reason: "not_visible" });
  expect(h.create).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pageshow"));
  const resumed = showRewardedAd(h.sdk, "slot");
  h.ads[1].close(true);
  await expect(resumed).resolves.toEqual({ status: "completed" });
});

it("50010 迟于回到前台的回调不会暂停新前台周期", async () => {
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "slot");
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pageshow"));
  h.ads[0].reject({ errorCode: "101150000", subErrorCode: "50010" });
  await expect(first).resolves.toMatchObject({ status: "failed", reason: "not_visible" });
  const next = showRewardedAd(h.sdk, "slot");
  h.ads[1].close(true);
  await expect(next).resolves.toEqual({ status: "completed" });
});

it("121401 保留原始错误码，同一宿主版本在回前台后仍停止激励广告调用", async () => {
  const h = nativeAds();
  const observe = vi.fn();
  const first = showRewardedAd(h.sdk, "slot", undefined, undefined, observe);
  h.ads[0].reject({ errorCode: "121401", errMsg: "TikTok version is too low, not supported this api" });
  await expect(first).resolves.toMatchObject({ status: "failed", reason: "client_outdated" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", stage: "show", errorCode: "121401" }));
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pageshow"));
  await expect(showRewardedAd(h.sdk, "slot")).resolves.toEqual({ status: "failed", reason: "client_outdated" });
  expect(h.create).toHaveBeenCalledOnce();
});

it("恢复意图校验抛错时停止旧请求，记录具体原因并脱敏", async () => {
  const h = nativeAds();
  let invalid = false;
  const intent = captureAdIntent(() => {
    if (invalid) throw new Error("Offer check failed token=private-value");
    return true;
  });
  const result = showRewardedAd(h.sdk, "slot", undefined, undefined, undefined, intent);
  h.ads[0].reject({ subErrorCode: "50008" });
  await vi.advanceTimersByTimeAsync(100);
  invalid = true;
  await vi.advanceTimersByTimeAsync(adPolicy.nativeAdRecoveryCheckMs);
  await expect(result).resolves.toEqual({ status: "failed", reason: "stale_intent" });
  expect(h.create).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_recovery_intent_failed", error: "Offer check failed token=[REDACTED]" }));
});

it("恢复诊断分配失败不会改变广告结果，日志保留脱敏原因", async () => {
  const h = nativeAds();
  const observer: AdObserver = Object.assign(vi.fn(), { nextAttempt: () => { throw new Error("Metric allocation failed token=private-value"); } });
  const result = showRewardedAd(h.sdk, "slot", undefined, undefined, observer);
  h.ads[0].reject({ errorCode: "11006" });
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedRecoveryDelayMs);
  h.ads[1].close(true);
  await expect(result).resolves.toEqual({ status: "completed" });
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_recovery_observer_failed", error: "Metric allocation failed token=[REDACTED]" }));
  expect(vi.getTimerCount()).toBe(0);
});
