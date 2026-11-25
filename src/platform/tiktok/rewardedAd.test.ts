import { afterEach, describe, expect, it, vi } from "vitest";

import { showRewardedAd } from "./rewardedAd";
import type { RewardedVideoAd, TikTokMinisSDK } from "./types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function adHarness(closeResult: { isEnded?: boolean }) {
  let closeListener: ((result: { isEnded?: boolean }) => void) | undefined;
  let errorListener: ((error: unknown) => void) | undefined;
  const ad: RewardedVideoAd = {
    show: vi.fn(async () => {
      queueMicrotask(() => closeListener?.(closeResult));
    }),
    onClose: vi.fn((listener) => {
      closeListener = listener;
    }),
    offClose: vi.fn((listener) => {
      if (closeListener === listener) closeListener = undefined;
    }),
    onError: vi.fn((listener) => {
      errorListener = listener;
    }),
    offError: vi.fn((listener) => {
      if (errorListener === listener) errorListener = undefined;
    }),
  };
  const sdk = {
    canIUse: vi.fn(() => true),
    createRewardedVideoAd: vi.fn(() => ad),
  } as unknown as TikTokMinisSDK;
  return { ad, sdk };
}

describe("showRewardedAd", () => {
  it("官方展示成功才回传展示，show 抛异常时不伪造展示或奖励", async () => {
    const harness = adHarness({ isEnded: true });
    const onShown = vi.fn();
    await showRewardedAd(harness.sdk, "placement-1", onShown);
    await Promise.resolve();
    expect(onShown).toHaveBeenCalledTimes(1);
    onShown.mockClear();
    harness.ad.show = () => { throw new Error("provider-private-error"); };
    await expect(showRewardedAd(harness.sdk, "placement-1", onShown)).resolves.toMatchObject({status:"failed"});
    expect(onShown).not.toHaveBeenCalled();
  });
  it("returns completed only when TikTok reports a fully watched ad", async () => {
    const completed = adHarness({ isEnded: true });
    const cancelled = adHarness({ isEnded: false });

    await expect(showRewardedAd(completed.sdk, "placement-1")).resolves.toEqual({ status: "completed" });
    await expect(showRewardedAd(cancelled.sdk, "placement-1")).resolves.toEqual({ status: "cancelled" });
  });

  it("creates one ad instance per display and removes listeners after close", async () => {
    const first = adHarness({ isEnded: true });

    await showRewardedAd(first.sdk, "placement-1");

    expect(first.sdk.createRewardedVideoAd).toHaveBeenCalledTimes(1);
    expect(first.ad.offClose).toHaveBeenCalledTimes(1);
    expect(first.ad.offError).toHaveBeenCalledTimes(1);
  });

  it("does not call IAA when the TikTok client cannot prove capability support", async () => {
    const sdk = {
      createRewardedVideoAd: vi.fn(),
    } as unknown as TikTokMinisSDK;

    await expect(showRewardedAd(sdk, "placement-1")).resolves.toEqual({ status: "unsupported" });
    expect(sdk.createRewardedVideoAd).not.toHaveBeenCalled();
  });

  it("展示调用一直未确认时返回未知结果，不伪造失败或取消", async () => {
    vi.useFakeTimers();
    const harness = pendingAd();
    harness.ad.show = vi.fn(() => new Promise<void>(() => {}));
    const result = showRewardedAd(harness.sdk, "placement-1");
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toEqual({ status: "unknown" });
    harness.error(new Error("测试结束原生等待"));
  });

});

// pendingAd 暴露回调以验证异常、迟到响应和可见时间，不使用真实平台服务。
function pendingAd() {
  let close!: (result: { isEnded?: boolean }) => void;
  let error!: (reason: unknown) => void;
  const ad: RewardedVideoAd = {
    show: vi.fn(async () => undefined),
    onClose: vi.fn((fn) => { close = fn; }),
    onError: vi.fn((fn) => { error = fn; }),
    offClose: vi.fn(), offError: vi.fn(),
  };
  return { ad, sdk: { canIUse: () => true, createRewardedVideoAd: () => ad } as unknown as TikTokMinisSDK,
    close: (ended = true) => close({ isEnded: ended }), error: (reason: unknown) => error(reason) };
}

it.each(["capability", "creation", "show"])("广告 %s 抛错时返回失败、记录具体原因且不回传展示", async (step) => {
  const harness = pendingAd();
  const failure = () => { throw new Error("Bridge offline token=private-value"); };
  if (step === "capability") harness.sdk.canIUse = failure;
  else if (step === "creation") harness.sdk.createRewardedVideoAd = failure;
  else harness.ad[step as "onClose" | "onError" | "show"] = failure;
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const shown = vi.fn();
  await expect(showRewardedAd(harness.sdk, "ad", shown)).resolves.toMatchObject({ status: "failed" });
  expect(shown).not.toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).toContain("Bridge offline");
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-value");
});

it("解绑抛错仍完成结算并尝试所有清理，重复关闭和迟到失败不重复处理", async () => {
  const harness = pendingAd();
  harness.ad.offClose = vi.fn(() => { throw new Error("detach failed"); });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const shown = vi.fn();
  const result = showRewardedAd(harness.sdk, "ad", shown);
  await Promise.resolve();
  harness.close(); harness.close(); harness.error(new Error("late error"));
  await expect(result).resolves.toEqual({ status: "completed" });
  expect(harness.ad.offError).toHaveBeenCalledOnce();
  expect(shown).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith({ event: "rewarded_ad_close_listener_remove_failed", error: "detach failed" });
});

it("展示等待超时后仍接收迟到展示与关闭，且只确认一次展示", async () => {
  vi.useFakeTimers();
  const harness = pendingAd();
  let shown!: () => void;
  harness.ad.show = () => new Promise<void>((resolve) => { shown = resolve; });
  const event = vi.fn();
  const result = showRewardedAd(harness.sdk, "ad", event);
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toEqual({ status: "unknown" });
  shown(); harness.close();
  await Promise.resolve();
  expect(event).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("后台返回不推断取消，仍等待原生关闭确认完播", async () => {
  vi.useFakeTimers();
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  const harness = pendingAd();
  const settled = vi.fn();
  const result = showRewardedAd(harness.sdk, "ad").then((value) => { settled(value); return value; });
  await vi.advanceTimersByTimeAsync(1000);
  visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(600_000);
  expect(settled).not.toHaveBeenCalled();
  visibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1_500);
  expect(settled).not.toHaveBeenCalled();
  harness.close(true);
  await expect(result).resolves.toEqual({ status: "completed" });
  await Promise.resolve();
  expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
  expect(vi.getTimerCount()).toBe(0);
});

it("展示回传异常不影响完整观看的奖励结果", async () => {
  const harness = adHarness({ isEnded: true });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(showRewardedAd(harness.sdk, "ad", () => { throw new Error("report unavailable"); })).resolves.toEqual({ status: "completed" });
  await Promise.resolve();
  expect(log).toHaveBeenCalledWith({ event: "rewarded_ad_report_failed", error: "report unavailable" });
});

it("加载期间用户切到后台随后展示失败，不计入成功展示", async () => {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const harness = pendingAd();
  harness.ad.show = () => new Promise(() => {});
  const shown = vi.fn();
  const result = showRewardedAd(harness.sdk, "ad", shown);
  visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  harness.error(new Error("No ad inventory"));
  await expect(result).resolves.toMatchObject({ status: "failed" });
  expect(shown).not.toHaveBeenCalled();
});

it("广告正常完成与用户取消不误报错误日志", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await showRewardedAd(adHarness({ isEnded: true }).sdk, "ad");
  await showRewardedAd(adHarness({ isEnded: false }).sdk, "ad");
  expect(log).not.toHaveBeenCalled();
});
