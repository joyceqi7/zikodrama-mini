import { captureAdIntent } from "./adIntent";
import { ensureVisibilityTracking, disposeVisibilityTracking, getVisibilitySnapshot } from "./lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { adPolicy } from "../../config/adPolicy";
import { MetricCollector, type MetricEvent } from "../../observability/metrics";
import { hasPendingFullscreenAd, isFullscreenAdBlockingPlayback, lastFullscreenAdEndedAt, showFullscreenAd } from "./fullscreenAd";
import type { showRewardedAd as showRewardedWithRecovery } from "./rewardedAd";
import { FullscreenAdGate, showInterstitial } from "./interstitialAd";
import type { RewardedAdCloseResult, TikTokMinisSDK } from "./types";

// 本文件验证单次原生调用的锁和回调；业务层静默恢复另由 rewardedAdRecovery 覆盖。
const showRewardedAd: typeof showRewardedWithRecovery = (sdk, adUnitId, ...callbacks) =>
  showFullscreenAd(sdk, adUnitId, "rewarded", ...callbacks);

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

/** nativeAds 用可控原生 Promise 和回调验证容器互斥，不访问 TikTok 服务。 */
function nativeAds() {
  const lifecycle = new Map<string, { event: string; listener: () => void }>();
  const instances: Array<{
    show: ReturnType<typeof vi.fn>;
    shown(): void;
    reject(reason: unknown): void;
    close(ended?: boolean): void;
    error(reason: unknown): void;
  }> = [];
  let sequence = 0;
  const create = vi.fn(() => {
    let close!: (value: RewardedAdCloseResult) => void;
    let error!: (reason: unknown) => void;
    let shown!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, fail) => { shown = resolve; reject = fail; });
    const show = vi.fn(() => promise);
    instances.push({ show, shown, reject, close: (isEnded = false) => close({ isEnded }), error: reason => error(reason) });
    return { show, onClose: (fn: typeof close) => { close = fn; }, onError: (fn: typeof error) => { error = fn; },
      offClose: vi.fn(), offError: vi.fn() };
  });
  const sdk = {
    canIUse: () => true, createRewardedVideoAd: create, createInterstitialAd: create,
    on: (event: string, listener: () => void) => { const id = String(++sequence); lifecycle.set(id, { event, listener }); return id; },
    off: (_event: string, id: string) => lifecycle.delete(id),
  } as unknown as TikTokMinisSDK;
  const emit = (event: string) => [...lifecycle.values()].filter(value => value.event === event).forEach(value => value.listener());
  cleanups.push(() => instances.forEach(instance => instance.close()));
  return { sdk, create, instances, emit, lifecycle };
}

it.each(["ad_shown", "ad_failure"] as const)("跨批次关联原生关闭、关闭后的生命周期与 %s", async outcome => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const batches: MetricEvent[][] = [];
  const collector = new MetricCollector(async events => { batches.push(events); });
  cleanups.push(() => collector.dispose());
  collector.identify("A");
  const metadata = { adType: "rewarded", adUnitId: "slot", scene: "entry_reward", clientVersion: "build", os: "ios", tiktokVersion: "46.1" } as const;
  const previous = collector.captureAd(metadata, "previous-attempt-01");
  const first = showRewardedAd(h.sdk, "slot", undefined, undefined, previous);
  h.emit("minis.show");
  await vi.advanceTimersByTimeAsync(100);
  h.instances[0].close(false);
  await first;
  await collector.flush();
  const closed = batches[0].find(event => event.kind === "ad_closed")!;
  expect(closed).toMatchObject({ id: previous.attemptId, adTimeline: { atMs: 100, nativeVisibility: "visible" } });

  await vi.advanceTimersByTimeAsync(200);
  h.emit("minis.hide");
  await vi.advanceTimersByTimeAsync(300);
  h.emit("minis.show");
  h.emit("minis.show");
  await vi.advanceTimersByTimeAsync(300);
  const current = collector.captureAd(metadata, "current-attempt-02");
  const second = showRewardedAd(h.sdk, "slot", undefined, undefined, current);
  expect(h.instances[1].show).toHaveBeenCalledOnce();
  await collector.flush();
  const request = batches[1].find(event => event.kind === "ad_request")!;
  expect(request).toMatchObject({ id: current.attemptId, adTimeline: {
    atMs: 900, nativeVisibility: "visible", request: {
      previousAttemptId: closed.id, previousCloseAtMs: 100, userInitiated: false, lifecycleTruncated: false,
      lifecycle: [
        { atMs: 300, source: "minis.hide", nativeVisibility: "hidden" },
        { atMs: 600, source: "minis.show", nativeVisibility: "visible" },
        { atMs: 600, source: "minis.show", nativeVisibility: "visible" },
      ],
    },
  } });

  h.emit("minis.hide");
  await vi.advanceTimersByTimeAsync(150);
  if (outcome === "ad_shown") {
    h.instances[1].shown();
    await Promise.resolve();
    h.instances[1].close(true);
    expect(await second).toEqual({ status: "completed" });
  } else {
    h.instances[1].reject({ errorCode: "101150000", subErrorCode: "50008", errMsg: "unavailable token=private" });
    expect(await second).toMatchObject({ status: "failed", reason: "container_unavailable" });
  }
  await collector.flush();
  const result = batches[2].find(event => event.kind === outcome)!;
  expect(result).toMatchObject({ id: request.id, adTimeline: { atMs: 1050, nativeVisibility: "hidden", documentVisibility: "visible", prerendering: false } });
  expect(result.adTimeline?.request).toBeUndefined();
  expect(JSON.stringify(batches)).not.toContain("private");

  // 同一 SDK 更换用户后，既有关闭事实不能串到新主体的调用。
  collector.identify("B");
  h.emit("minis.show");
  const next = showRewardedAd(h.sdk, "slot", undefined, undefined, collector.captureAd(metadata));
  h.instances[2].close(false);
  await next;
  await collector.flush();
  expect(batches.at(-1)?.find(event => event.kind === "ad_request")?.adTimeline?.request).toEqual({ userInitiated: false });
});

it("原生与网页重复后台信号不重复扣时，返回1.5秒仍等待官方结果", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const h = nativeAds();
  const settled = vi.fn();
  const pending = showRewardedAd(h.sdk, "ad").then(settled);
  await vi.advanceTimersByTimeAsync(1_000);
  h.emit("minis.hide");
  await vi.advanceTimersByTimeAsync(1_000);
  visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  h.emit("minis.hide");
  await vi.advanceTimersByTimeAsync(600_000);
  visibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(settled).not.toHaveBeenCalled();
  h.emit("minis.show");
  await vi.advanceTimersByTimeAsync(13_999);
  expect(settled).not.toHaveBeenCalled();
  h.instances[0].close(true);
  await pending;
  expect(settled).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
  expect(h.lifecycle.size).toBe(3); // 页面级监听继续保存前后台证据。
});

it("展示超时后跨广告位和类型拒绝第二次原生请求，迟到完播仅恢复一次", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const shown = vi.fn();
  const completed = vi.fn();
  const first = showRewardedAd(h.sdk, "ad", shown, completed);
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
  expect(await first).toEqual({ status: "unknown" });
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_timeout", stage: "show", outcome: "unknown" }));
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  expect(completed).not.toHaveBeenCalled();
  expect(await showRewardedAd(h.sdk, "another")).toEqual({ status: "unknown" });
  await showInterstitial(h.sdk, "interstitial", vi.fn());
  expect(h.create).toHaveBeenCalledOnce();
  h.instances[0].shown();
  await Promise.resolve();
  h.instances[0].close(true); h.instances[0].close(true);
  expect(shown).toHaveBeenCalledOnce();
  expect(completed).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  const next = showRewardedAd(h.sdk, "ad");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(true); await next;
});

it.each([
  ["rewarded", "show"], ["rewarded", "close"], ["rewarded", "late_show"],
  ["interstitial", "show"], ["interstitial", "close"], ["interstitial", "late_show"],
] as const)("%s 的 %s 阶段始终无终止回调时恢复页面，容器销毁前不重复请求", async (kind, phase) => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const completed = vi.fn();
  const first = kind === "rewarded" ? showRewardedAd(h.sdk, "ad", undefined, completed) : showInterstitial(h.sdk, "ad", vi.fn());
  const showTimeout = kind === "rewarded" ? adPolicy.rewardedShowTimeoutMs : adPolicy.interstitialTimeoutMs;
  const closeTimeout = kind === "rewarded" ? adPolicy.rewardedCloseTimeoutMs : adPolicy.interstitialTimeoutMs;
  expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(true);
  if (phase === "close") h.instances[0].shown();
  await vi.advanceTimersByTimeAsync(phase === "close" ? closeTimeout : showTimeout);
  await first;
  expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(false);
  if (phase === "late_show") {
    h.instances[0].shown(); await Promise.resolve();
    expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(true);
    await vi.advanceTimersByTimeAsync(closeTimeout);
    expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(3_600_000);
  h.emit("minis.hide"); h.emit("minis.show");
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await showRewardedAd(h.sdk, `other-${attempt}`)).toEqual({ status: "unknown" });
    await showInterstitial(h.sdk, "interstitial", vi.fn());
  }
  expect(h.create).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(false);
  expect(completed).not.toHaveBeenCalled();
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: `${kind === "rewarded" ? "rewarded" : "interstitial"}_ad_timeout`,
    recovery: "reopen_mini", error: expect.stringContaining("callback timed out") }));
  expect(errors).toHaveBeenCalledTimes(phase === "late_show" ? 2 : 1);

  // 宿主销毁确认容器已终止；旧回调不能清除重开后的新锁或补造完播。
  h.emit("minis.destroy");
  expect(h.lifecycle.size).toBe(3); // 页面级监听继续保存前后台证据。
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  disposeVisibilityTracking(); // 模拟重新打开 Mini 的新页面运行时。
  const next = showRewardedAd(h.sdk, "new-ad");
  h.instances[0].close(true); h.instances[0].shown(); h.instances[0].error(new Error("stale callback"));
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.instances[1].close(true);
  expect(await next).toEqual({ status: "completed" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it("容器在超时前销毁时结束页面等待，重复销毁不发奖", async () => {
  const h = nativeAds();
  const completed = vi.fn();
  const first = showRewardedAd(h.sdk, "ad", undefined, completed);
  h.emit("minis.destroy"); h.emit("minis.destroy");
  expect(await first).toEqual({ status: "unknown" });
  h.instances[0].close(true);
  expect(completed).not.toHaveBeenCalled();
  expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(false);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(h.lifecycle.size).toBe(3); // 页面级监听继续保存前后台证据。
});

it.each(["subscribe", "cleanup"] as const)("容器销毁监听 %s 异常保留实际错误和数值码、隐藏敏感值且不改变完播结果", async (operation) => {
  const h = nativeAds();
  const log = vi.spyOn(console, operation === "subscribe" ? "warn" : "error").mockImplementation(() => {});
  const errors = vi.spyOn(console, operation === "subscribe" ? "error" : "warn").mockImplementation(() => {});
  const reason = { errorCode: "50101", subErrorCode: 42,
    errMsg: "lifecycle bridge failed token=private-value https://ads.example/private", token: "private-value" };
  const on = h.sdk.on!.bind(h.sdk), off = h.sdk.off!.bind(h.sdk);
  if (operation === "subscribe") h.sdk.on = (event, fn) => { if (event === "minis.destroy") throw reason; return on(event, fn); };
  else h.sdk.off = (event, id) => { if (event === "minis.destroy") throw reason; return off(event, id); };
  const first = showRewardedAd(h.sdk, "ad");
  h.instances[0].close(true);
  expect(await first).toEqual({ status: "completed" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({
    event: operation === "subscribe" ? "rewarded_ad_destroy_listener_failed" : "rewarded_ad_destroy_listener_remove_failed",
    errorCode: "50101", subErrorCode: "42", error: "lifecycle bridge failed token=[REDACTED] [URL]",
  }));
  expect(JSON.stringify([...log.mock.calls, ...errors.mock.calls])).not.toContain("private-value");
  if (operation === "subscribe") expect(errors).not.toHaveBeenCalled();
});

it("展示成功不提前解锁互斥，关闭等待超时后仍能接收原生终止", async () => {
  vi.useFakeTimers();
  const h = nativeAds();
  const completed = vi.fn();
  const first = showRewardedAd(h.sdk, "ad", undefined, completed);
  h.instances[0].shown();
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedCloseTimeoutMs);
  expect(await first).toEqual({ status: "unknown" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.instances[0].error({ errorCode: 50101, errMsg: "network unavailable" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.instances[0].close(false);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(completed).not.toHaveBeenCalled();
  await showRewardedAd(h.sdk, "ad");
  expect(h.create).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  const second = showRewardedAd(h.sdk, "ad");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(true); await second;
});

it("插屏超时同样保留容器互斥，迟到成功与关闭仅记录一次展示", async () => {
  vi.useFakeTimers();
  const h = nativeAds();
  const shown = vi.fn();
  const first = showInterstitial(h.sdk, "slot", shown);
  await vi.advanceTimersByTimeAsync(adPolicy.interstitialTimeoutMs);
  await first;
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  await showRewardedAd(h.sdk, "rewarded");
  expect(h.create).toHaveBeenCalledOnce();
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].close();
  expect(shown).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it("插屏间隔从迟到的原生结束计算，不能从本地超时提前起算", async () => {
  vi.useFakeTimers();
  const h = nativeAds();
  const gate = new FullscreenAdGate();
  const release = gate.acquire(false)!;
  const ad = showRewardedAd(h.sdk, "ad");
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
  await ad; release();
  await vi.advanceTimersByTimeAsync(60_000);
  h.instances[0].close(true);
  await vi.advanceTimersByTimeAsync(adPolicy.interstitialIntervalMs - 1);
  expect(gate.acquire(true, h.sdk)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(gate.acquire(true, h.sdk)).toBeTypeOf("function");
});

it("创建频控与展示取消的30001按调用来源区分，错误码与子码保留且敏感值脱敏", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  h.create.mockImplementationOnce(() => { throw { error_code: 30001, sub_error_code: "101330001",
    error_msg: "request throttled token=private-value https://ads.example/private", token: "private-value" }; });
  expect((await showRewardedAd(h.sdk, "ad")).status).toBe("failed");
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_create_failed", stage: "create",
    errorCode: "30001", subErrorCode: "101330001", elapsedMs: 0, error: "request throttled token=[REDACTED] [URL]" }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  const cancelled = showRewardedAd(h.sdk, "ad");
  h.instances[0].reject({ errorCode: 30001, errMsg: "user exited" });
  expect(await cancelled).toEqual({ status: "cancelled" });
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_cancelled", stage: "show", errorCode: "30001" }));
  expect(error).not.toHaveBeenCalled();
});

it("SDK失败记录白名单数值码及实际消息，明确失败后必须经过退避才能创建新实例", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "ad");
  h.instances[0].error({ error: { error_code: "50101", sub_error_code: "7", error_msg: "offline cookie=private-cookie" },
    access_token: "private-token", response: { sensitive: "private-response" } });
  expect(await first).toMatchObject({ status: "failed" });
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", stage: "callback",
    errorCode: "50101", subErrorCode: "7", error: "offline cookie=[REDACTED]" }));
  expect(JSON.stringify(error.mock.calls)).not.toContain("private-");
  // onError 不能替代尚未完成的 show 结果；明确拒绝后才进入退避。
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.instances[0].reject(new Error("show rejected")); await Promise.resolve();
  await showRewardedAd(h.sdk, "ad");
  expect(h.create).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  const next = showRewardedAd(h.sdk, "ad");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(true); await next;
});

it("已经确认展示后回调30001按用户取消处理，不误报错误日志", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const result = showRewardedAd(h.sdk, "ad");
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].error({ errorCode: 30001, errMsg: "user exited" });
  expect(await result).toEqual({ status: "cancelled" });
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_cancelled", stage: "callback", errorCode: "30001" }));
  expect(error).not.toHaveBeenCalled();
});

it.each(["create", "setup", "show", "callback"] as const)("%s 失败后跨广告位和类型共用退避，拒绝重试不延长等待", async stage => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const infos = vi.spyOn(console, "info").mockImplementation(() => {});
  const h = nativeAds();
  const failure = { errorCode: 50101, errMsg: "network unavailable token=private-token https://ads.example/private" };
  if (stage === "create") h.create.mockImplementationOnce(() => { throw failure; });
  if (stage === "setup") {
    const create = h.create.getMockImplementation()!;
    h.create.mockImplementationOnce(() => {
      const ad = create();
      return { ...ad, onClose: listener => { ad.onClose(listener); throw failure; } };
    });
  }
  const first = showRewardedAd(h.sdk, "ad-a");
  if (stage === "show") h.instances[0].reject(failure);
  if (stage === "callback") { h.instances[0].error(failure); h.instances[0].reject(failure); }
  expect(await first).toMatchObject({ status: "failed" });
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: `rewarded_ad_${stage}_failed`, error: "network unavailable token=[REDACTED] [URL]" }));
  const observe = vi.fn();
  expect(await showRewardedAd(h.sdk, "ad-b", undefined, undefined, observe)).toMatchObject({ status: "failed" });
  await showInterstitial(h.sdk, "interstitial-b", vi.fn());
  expect(h.create).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_skipped", reason: "cooldown" }));
  expect(infos).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_deferred", error: "Ad display deferred: cooldown" }));
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs - 1);
  expect(await showRewardedAd(h.sdk, "ad-c")).toMatchObject({ status: "failed" });
  await vi.advanceTimersByTimeAsync(1);
  errors.mockClear();
  const next = showRewardedAd(h.sdk, "ad-c");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances.at(-1)!.close(true);
  expect(await next).toEqual({ status: "completed" });
  expect(errors).not.toHaveBeenCalled();
});

it("插屏失败同样阻止激励立即请求，但不同 SDK 容器不共享失败状态", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), other = nativeAds();
  const first = showInterstitial(h.sdk, "interstitial", vi.fn());
  h.instances[0].error({ errorCode: 50101, errMsg: "network unavailable" });
  await first;
  expect(await showRewardedAd(h.sdk, "reward")).toEqual({ status: "unknown" });
  h.instances[0].reject(new Error("show rejected")); await Promise.resolve();
  expect(await showRewardedAd(h.sdk, "reward")).toMatchObject({ status: "failed" });
  expect(h.create).toHaveBeenCalledOnce();
  const isolated = showRewardedAd(other.sdk, "reward");
  other.instances[0].close(true);
  expect(await isolated).toEqual({ status: "completed" });
});

it.each([true, false])("正常关闭 isEnded=%s 不限制下一个广告位的业务续看", async completed => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "ad-a");
  h.instances[0].close(completed);
  await first;
  const second = showRewardedAd(h.sdk, "ad-b");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(true);
  await second;
  expect(errors).not.toHaveBeenCalled();
});

it("只有关闭而没有成功展示或完播证明时不伪造曝光，确认关闭后允许业务选择重看", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const shown = vi.fn();
  const first = showRewardedAd(h.sdk, "ad", shown);
  h.instances[0].close(false);
  expect(await first).toEqual({ status: "cancelled" });
  expect(shown).not.toHaveBeenCalled();
  const second = showRewardedAd(h.sdk, "ad");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(true); await second;
  expect(error).not.toHaveBeenCalled();
});

it("迟到完播处理失败记录具体脱敏错误并释放原生互斥", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "ad", undefined, () => { throw new Error("storage blocked token=private-value"); });
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
  await first;
  h.instances[0].close(true);
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_late_completion_failed", error: "storage blocked token=[REDACTED]" }));
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it("广告阶段按实际 SDK 调用记录，迟到展示更新原调用，失败不抵消展示", async () => {
  vi.useFakeTimers();
  const h = nativeAds();
  const observe = vi.fn();
  const pending = showRewardedAd(h.sdk, "ad", undefined, undefined, observe);
  expect(observe.mock.calls.map(([entry]) => entry.kind)).toEqual(["ad_trigger", "ad_create", "ad_created", "ad_request"]);
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
  expect(await pending).toEqual({ status: "unknown" });
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_show_unknown" }));
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].error({ errorCode: 50000, subErrorCode: 50101 });
  const phases = observe.mock.calls.map(([entry]) => entry.kind);
  expect(phases.filter(kind => kind === "ad_shown")).toHaveLength(1);
  expect(phases.filter(kind => kind === "ad_request")).toHaveLength(1);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", stage: "callback", errorCode: "50000", subErrorCode: "50101" }));
});

it.each(["rewarded", "interstitial"] as const)("%s 按短剧 H5 顺序创建、注册回调后直接展示，宿主暴露加载方法也不调用", async kind => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const original = h.create.getMockImplementation()!;
  const order: string[] = [];
  // 故意暴露永不完成的加载方法，防止后续实现重新把展示绑到可选能力上。
  const load = vi.fn(() => new Promise<void>(() => {}));
  const onLoad = vi.fn(), offLoad = vi.fn();
  const capability = vi.fn(() => true);
  h.sdk.canIUse = capability;
  h.create.mockImplementation(() => {
    order.push("create");
    const ad = original();
    return { ...ad, load, onLoad, offLoad,
      onClose: listener => { order.push("onClose"); ad.onClose(listener); },
      onError: listener => { order.push("onError"); ad.onError(listener); },
      show: vi.fn(() => { order.push("show"); return ad.show(); }),
    };
  });
  const observe = vi.fn(), shown = vi.fn(), completed = vi.fn();
  const pending = kind === "rewarded" ? showRewardedAd(h.sdk, "ad", shown, completed, observe) : showInterstitial(h.sdk, "ad", shown, observe);
  expect(order).toEqual(["create", "onClose", "onError", "show"]);
  expect(capability.mock.calls).toEqual([[kind === "rewarded" ? "createRewardedVideoAd" : "createInterstitialAd"]]);
  expect(observe.mock.calls.map(([event]) => event.kind)).toEqual(["ad_trigger", "ad_create", "ad_created", "ad_request"]);
  expect(shown).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  h.instances[0].shown(); await Promise.resolve();
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_shown", stage: "show", evidence: "show_promise", showElapsedMs: 250 }));
  h.instances[0].close(true); h.instances[0].close(true); h.instances[0].error(new Error("stale callback"));
  await pending;
  expect(h.create).toHaveBeenCalledOnce();
  expect(h.instances[0].show).toHaveBeenCalledOnce();
  expect(shown).toHaveBeenCalledOnce();
  expect(completed).not.toHaveBeenCalled();
  expect(observe.mock.calls.map(([event]) => event.kind)).toEqual([
    "ad_trigger", "ad_create", "ad_created", "ad_request", "ad_shown", "ad_closed", ...(kind === "rewarded" ? ["ad_complete"] : []),
  ]);
  expect(load).not.toHaveBeenCalled(); expect(onLoad).not.toHaveBeenCalled(); expect(offLoad).not.toHaveBeenCalled();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(h.lifecycle.size).toBe(3); // 页面级监听继续保存前后台证据。
  expect(errors).not.toHaveBeenCalled();
});

it.each(["sync", "async"] as const)("直接 show 的 %s 失败只记录一次请求和失败，保留脱敏错误及子码", async mode => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const original = h.create.getMockImplementation()!;
  const reason = { errorCode: 50101, subErrorCode: "42", errMsg: "bridge offline token=private-value https://ads.example/private" };
  h.create.mockImplementationOnce(() => ({ ...original(), show: vi.fn(() => {
    if (mode === "sync") throw reason;
    return Promise.reject(reason);
  }) }));
  const observe = vi.fn();
  expect(await showRewardedAd(h.sdk, "ad", undefined, undefined, observe)).toMatchObject({ status: "failed", message: "bridge offline token=[REDACTED] [URL]" });
  h.instances[0].error(reason); h.instances[0].close(true);
  expect(observe.mock.calls.map(([event]) => event.kind)).toEqual(["ad_trigger", "ad_create", "ad_created", "ad_request", "ad_failure"]);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", stage: "show", errorCode: "50101", subErrorCode: "42" }));
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_show_failed", stage: "show", error: "bridge offline token=[REDACTED] [URL]", errorCode: "50101", subErrorCode: "42" }));
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(JSON.stringify([...observe.mock.calls, ...error.mock.calls])).not.toContain("private");
});

it("回调注册失败不调用 show、不计展示请求，保留错误并可在退避后重试", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const original = h.create.getMockImplementation()!;
  h.create.mockImplementationOnce(() => ({ ...original(), onError: () => { throw { errorCode: 50000, errMsg: "listener unavailable cookie=private-value" }; } }));
  const observe = vi.fn();
  expect(await showRewardedAd(h.sdk, "ad", undefined, undefined, observe)).toMatchObject({ status: "failed" });
  expect(h.instances[0].show).not.toHaveBeenCalled();
  expect(observe.mock.calls.map(([event]) => event.kind)).toEqual(["ad_trigger", "ad_create", "ad_created", "ad_failure"]);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", stage: "setup", errorCode: "50000" }));
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_setup_failed", error: "listener unavailable cookie=[REDACTED]" }));
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(h.lifecycle.size).toBe(3); // 页面级监听继续保存前后台证据。
  await showRewardedAd(h.sdk, "ad"); expect(h.create).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  const next = showRewardedAd(h.sdk, "ad");
  h.instances[1].close(true); expect(await next).toEqual({ status: "completed" });
  expect(h.create).toHaveBeenCalledTimes(2);
});

it("广告采集异常记录具体脱敏消息，仍直接展示且只确认一次完播", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const shown = vi.fn(), completed = vi.fn();
  const pending = showRewardedAd(h.sdk, "ad", shown, completed, () => { throw new Error("collector unavailable token=private-value"); });
  expect(h.instances[0].show).toHaveBeenCalledOnce();
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].close(true); h.instances[0].close(true);
  expect(await pending).toEqual({ status: "completed" });
  expect(shown).toHaveBeenCalledOnce();
  expect(completed).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith({ event: "ad_metric_record_failed", error: "collector unavailable token=[REDACTED]" });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
  expect(error).not.toHaveBeenCalled();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it("已展示广告报错仍保留原生互斥；五秒后不重拉，迟到关闭才释放且不重复上报失败诊断", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), observe = vi.fn(), complete = vi.fn();
  const first = showRewardedAd(h.sdk, "reward", undefined, complete, Object.assign(observe, { attemptId: "attempt-a" }));
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].error({ errorCode: 50101, errMsg: "playback failed" });
  expect(await first).toMatchObject({ status: "failed" });
  h.instances[0].error({ errorCode: 50101, errMsg: "duplicate" });
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  expect(await showRewardedAd(h.sdk, "another")).toEqual({ status: "unknown" });
  await showInterstitial(h.sdk, "interstitial", vi.fn());
  expect(h.create).toHaveBeenCalledOnce();
  expect(lastFullscreenAdEndedAt(h.sdk)).toBe(-Infinity);
  h.instances[0].close(true);
  expect(complete).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  const failures = observe.mock.calls.map(([entry]) => entry).filter(entry => entry.kind === "ad_failure");
  expect(failures).toHaveLength(1);
  expect(failures[0].failure).toMatchObject({ shown: true, lockOwnerId: "attempt-a", error: "playback failed" });
  expect(observe.mock.calls.filter(([entry]) => entry.kind !== "ad_failure").every(([entry]) => !entry.failure)).toBe(true);
  const second = showRewardedAd(h.sdk, "another");
  h.instances[0].close(true);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
  h.instances[1].close(false); await second;
});

it.each(["104111006", "11006"])("%s 明确拒绝只释放自己，保留原始码；迟到关闭不能释放下一次调用或冒充完播", async errorCode => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), observe = vi.fn(), completed = vi.fn();
  const first = showRewardedAd(h.sdk, "reward", undefined, completed, observe);
  h.instances[0].error({ errorCode, subErrorCode: "11006", errMsg: "another ad is active token=private" });
  expect(await first).toMatchObject({ status: "failed" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(lastFullscreenAdEndedAt(h.sdk)).toBe(-Infinity);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", reason: "ad_active_conflict", errorCode, subErrorCode: "11006" }));
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  expect(h.create).toHaveBeenCalledOnce(); // 不自动重试。
  const next = showRewardedAd(h.sdk, "reward");
  h.instances[0].error({ errorCode, subErrorCode: "11006" });
  h.instances[0].close(true);
  expect(observe.mock.calls.some(([e]) => e.kind === "ad_closed")).toBe(false);
  expect(completed).not.toHaveBeenCalled();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  expect(lastFullscreenAdEndedAt(h.sdk)).toBe(-Infinity);
  expect(JSON.stringify(observe.mock.calls)).not.toContain("private");
  h.instances[1].close(false); await next;
});

it("已展示后错误且始终没有关闭，只结束有界页面阻塞，不因五秒退避释放原生锁", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "reward");
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].error(new Error("playback failed")); await first;
  expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(true);
  await vi.advanceTimersByTimeAsync(adPolicy.rewardedCloseTimeoutMs);
  expect(isFullscreenAdBlockingPlayback(h.sdk)).toBe(false);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
});

it("onError 早于 show 成功时不提前放行，迟到成功和完播仍只处理一次", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), shown = vi.fn(), complete = vi.fn();
  const first = showRewardedAd(h.sdk, "reward", shown, complete);
  h.instances[0].error(new Error("callback error")); await first;
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.instances[0].shown(); await Promise.resolve();
  h.instances[0].close(true); h.instances[0].close(true);
  expect(shown).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
});

it("明确 show 拒绝立即清理监听和计时器，迟到回调不影响新调用或制造关闭", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), complete = vi.fn();
  const first = showRewardedAd(h.sdk, "reward", undefined, complete);
  h.instances[0].reject({ errorCode: "11006" }); await first;
  expect(h.create.mock.results[0].value.offClose).toHaveBeenCalledOnce();
  expect(h.create.mock.results[0].value.offError).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  expect(h.lifecycle.size).toBe(3); // 页面级监听继续保存前后台证据。
  expect(lastFullscreenAdEndedAt(h.sdk)).toBe(-Infinity);
  const next = showRewardedAd(h.sdk, "reward");
  h.instances[0].close(true);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  expect(complete).not.toHaveBeenCalled();
  h.instances[1].close(false); await next;
});

it("完播补证的 onShown 同步重入关闭时，终止回调只处理一次", async () => {
  const h = nativeAds(), observe = vi.fn(), completed = vi.fn();
  const shown = vi.fn(() => h.instances[0].close(true));
  const first = showRewardedAd(h.sdk, "reward", shown, completed, observe);
  h.instances[0].close(true);
  expect(await first).toEqual({ status: "completed" });
  expect(shown).toHaveBeenCalledOnce();
  expect(completed).not.toHaveBeenCalled();
  expect(observe.mock.calls.filter(([e]) => e.kind === "ad_complete")).toHaveLength(1);
  expect(observe.mock.calls.filter(([e]) => e.kind === "ad_closed")).toHaveLength(1);
});


it("订阅前已收到宿主 hide 时不创建广告，网页 visible 和组件重订阅不能抹去后台", async () => {
  const h = nativeAds(), observe = vi.fn();
  ensureVisibilityTracking(h.sdk);
  h.emit("minis.hide");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(await showRewardedAd(h.sdk, "slot", undefined, undefined, observe)).toEqual({ status: "failed", reason: "not_visible" });
  expect(h.create).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_skipped", reason: "not_visible" }));
  expect(getVisibilitySnapshot()).toMatchObject({ documentVisibility: "visible", nativeVisibility: "hidden" });
});

it.each(["hide", "route"] as const)("create 后 %s 变化时再次复核，不调用 show、不保留原生锁", async (change) => {
  const h = nativeAds(), observe = vi.fn();
  let current = true;
  const create = h.create.getMockImplementation()!;
  h.create.mockImplementationOnce(() => {
    const ad = create();
    if (change === "hide") h.emit("minis.hide"); else current = false;
    return ad;
  });
  expect(await showRewardedAd(h.sdk, "slot", undefined, undefined, observe, captureAdIntent(() => current))).toEqual({ status: "failed", reason: change === "hide" ? "not_visible" : "stale_intent" });
  expect(h.instances[0].show).not.toHaveBeenCalled();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(observe.mock.calls.some(([event]) => event.kind === "ad_request" || event.kind === "ad_failure")).toBe(false);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_skipped" }));
});

it("后台往返作废等待中的旧意图，恢复后只允许按当前业务重新生成意图", async () => {
  const h = nativeAds();
  ensureVisibilityTracking(h.sdk);
  const intent = captureAdIntent();
  h.emit("minis.hide"); h.emit("minis.show");
  expect(await showRewardedAd(h.sdk, "slot", undefined, undefined, undefined, intent)).toEqual({ status: "failed", reason: "stale_intent" });
  expect(h.create).not.toHaveBeenCalled();
  const next = showRewardedAd(h.sdk, "slot", undefined, undefined, undefined, captureAdIntent());
  h.instances[0].close(true);
  expect(await next).toEqual({ status: "completed" });
});

it.each(["show", "callback"] as const)("50008 %s 拒绝释放未展示调用，仅新前台周期或手动操作可创建新实例", async (source) => {
  vi.useFakeTimers();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), observe = vi.fn(), completed = vi.fn();
  const first = showRewardedAd(h.sdk, "slot", undefined, completed, observe);
  expect(getVisibilitySnapshot().nativeVisibility).toBe("unknown");
  const error = { error_code: 101150000, sub_error_code: 50000, inner_error_code: 50008, error_msg: "container unavailable", inner_error_msg: "prerender token=private-value" };
  if (source === "show") h.instances[0].reject(error); else h.instances[0].error(error);
  expect(await first).toMatchObject({ status: "failed", reason: "container_unavailable" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ kind: "ad_failure", errorCode: "101150000", subErrorCode: "50000", innerErrorCode: "50008", reason: "container_unavailable" }));
  const facts = observe.mock.calls.find(([entry]) => entry.kind === "ad_failure")![0].failure;
  expect(facts).toMatchObject({ showDocument: "visible", showNative: "unknown", errorDocument: "visible", errorNative: "unknown", shown: false, innerError: "prerender token=[REDACTED]" });
  expect(JSON.stringify(observe.mock.calls)).not.toContain("private-value");
  expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ innerError: "prerender token=[REDACTED]" }));
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private-value");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await showRewardedAd(h.sdk, "another")).toEqual({ status: "failed", reason: "container_suspended" });
  await showInterstitial(h.sdk, "interstitial", vi.fn());
  expect(h.create).toHaveBeenCalledOnce();
  h.emit("minis.show"); // 首次宿主前台确认允许重新评估，unknown 不会永久等事件。
  const second = showRewardedAd(h.sdk, "another");
  h.instances[0].close(true); h.instances[0].shown(); await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.instances[1].reject(error); await second;
  h.emit("minis.show"); // 重复 show 不是新的前台周期。
  expect(await showRewardedAd(h.sdk, "another")).toMatchObject({ reason: "container_suspended" });
  const manual = showRewardedAd(h.sdk, "another", undefined, undefined, undefined, captureAdIntent(() => true, true));
  expect(h.create).toHaveBeenCalledTimes(3);
  h.instances[2].close(true);
  expect(await manual).toEqual({ status: "completed" });
  const continued = showRewardedAd(h.sdk, "another"); // 手动恢复已确认展示，允许正常自动衔接。
  h.instances[3].reject(error); await continued;
  h.emit("minis.hide"); h.emit("minis.show");
  const resumed = showRewardedAd(h.sdk, "another");
  h.instances[4].close(false); await resumed;
});

it("50008 已展示后报错及广告引起的 hide 不释放锁，真正 onClose 后才恢复", async () => {
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "slot");
  h.instances[0].shown(); await Promise.resolve();
  h.emit("minis.hide");
  h.instances[0].error({ error_code: 101150000, sub_error_code: 50008 });
  expect(await first).toMatchObject({ reason: "container_unavailable" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  h.emit("minis.show");
  expect(await showRewardedAd(h.sdk, "another")).toEqual({ status: "unknown" });
  h.instances[0].close(false);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it.each(["show", "callback"] as const)("普通错误之后的 50008 %s 仍暂停自动展示，错误计数保持一次", async source => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), observe = vi.fn();
  const first = showRewardedAd(h.sdk, "slot", undefined, undefined, observe);
  h.instances[0].error({ errorCode: "102150000", subErrorCode: "50101", errMsg: "ad callback failed token=private" });
  expect(await first).toMatchObject({ status: "failed" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);

  const unavailable = { errorCode: "101150000", ...(source === "show" ? { subErrorCode: "50008" } : { innerErrorCode: "50008" }) };
  if (source === "show") h.instances[0].reject(unavailable); else h.instances[0].error(unavailable);
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  // 经过普通错误的退避期也不能绕过后续 50008 对当前前台周期的暂停。
  const next = showRewardedAd(h.sdk, "another");
  h.instances[1]?.close(false);
  expect(await next).toEqual({ status: "failed", reason: "container_suspended" });
  await showInterstitial(h.sdk, "interstitial", vi.fn());
  expect(h.create).toHaveBeenCalledOnce();
  expect(observe.mock.calls.filter(([event]) => event.kind === "ad_failure")).toHaveLength(1);
  expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", error: "ad callback failed token=[REDACTED]" }));
  expect(JSON.stringify(errors.mock.calls)).not.toContain("private");

  h.emit("minis.hide"); h.emit("minis.show");
  // 已结束的旧实例不能重新暂停新前台，恢复后仍按当前业务创建新实例。
  h.instances[0].error(unavailable);
  const resumed = showRewardedAd(h.sdk, "another");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(false);
  await resumed;
});

it("通用主码 101150000 和其他内部码不进入 50008 暂停", async () => {
  vi.useFakeTimers();
  const h = nativeAds();
  const first = showRewardedAd(h.sdk, "slot");
  h.instances[0].reject({ error_code: 101150000, sub_error_code: 50000, inner_error_code: 50101 });
  expect(await first).toMatchObject({ status: "failed" });
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  const next = showRewardedAd(h.sdk, "slot");
  expect(h.create).toHaveBeenCalledTimes(2);
  h.instances[1].close(false); await next;
});

it("50008 回调先于网页 visibilitychange 时，错误诊断仍采到当下网页后台状态", async () => {
  const h = nativeAds(), observe = vi.fn();
  const first = showRewardedAd(h.sdk, "slot", undefined, undefined, observe);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  h.instances[0].error({ error_code: 101150000, sub_error_code: 50008 });
  expect(await first).toMatchObject({ reason: "container_unavailable" });
  const failure = observe.mock.calls.find(([entry]) => entry.kind === "ad_failure")![0];
  expect(failure.failure).toMatchObject({ showDocument: "visible", errorDocument: "hidden", errorNative: "unknown" });
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
});

it.each([true, false])("失败仅附前次实际 show 的释放依据和已收到关闭事实：closed=%s", async closed => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = nativeAds(), observe = vi.fn();
  const first = showRewardedAd(h.sdk, "slot", undefined, undefined, Object.assign(vi.fn(), { attemptId: "previous-attempt-01" }));
  if (closed) h.instances[0].close(false);
  else h.instances[0].reject({ errorCode: "11006", subErrorCode: "11006" });
  await first;
  await vi.advanceTimersByTimeAsync(adPolicy.retryDelayMs);
  const second = showRewardedAd(h.sdk, "slot", undefined, undefined, Object.assign(observe, { attemptId: "current-attempt-02" }));
  h.instances[1].error({ errorCode: "104111006", subErrorCode: "11006", errMsg: "another ad active" });
  await second;
  const failure = observe.mock.calls.find(([entry]) => entry.kind === "ad_failure")![0].failure;
  expect(failure).toMatchObject({ previousAttemptId: "previous-attempt-01", previousRelease: closed ? "closed" : "active_conflict", lockOwnerId: "current-attempt-02" });
  expect(failure.previousCloseMs).toBe(closed ? adPolicy.retryDelayMs : undefined);
  expect(JSON.stringify(failure)).not.toMatch(/trace|sequence|snapshot|pageId|sdkId/);
  // 后续迟到关闭不能改写已排队的失败事实。
  h.instances[0].close(true);
  expect(failure.previousCloseMs).toBe(closed ? adPolicy.retryDelayMs : undefined);
});
