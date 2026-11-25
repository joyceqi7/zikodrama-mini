import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdDiagnosticRunner, type AdDiagnosticEvent } from "./adDiagnosticRunner";
import type { RewardedVideoAd, TikTokMinisSDK } from "./types";

function fixture() {
  const events: AdDiagnosticEvent[] = [];
  const ads: Array<{ ad: RewardedVideoAd; error: (e: unknown) => void; close: (e: { isEnded?: boolean }) => void }> = [];
  const create = vi.fn(() => {
    const entry = { ad: undefined as unknown as RewardedVideoAd, error: (_e: unknown) => {}, close: (_e: { isEnded?: boolean }) => {} };
    entry.ad = { show: vi.fn(async () => {}), onError: listener => { entry.error = listener; }, onClose: listener => { entry.close = listener; }, offClose: vi.fn(), offError: vi.fn() };
    ads.push(entry); return entry.ad;
  });
  const sdk = { canIUse: () => true, createRewardedVideoAd: create, createInterstitialAd: create } as unknown as TikTokMinisSDK;
  return { runner: new AdDiagnosticRunner(sdk, e => events.push(e)), sdk, create, events, ads };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("创建专测在异步 30001 后停止，保留原始回调来源和首次调用序号", async () => {
  const f = fixture();
  const run = f.runner.createBurst("rewarded", "slot", 20, 200);
  await vi.advanceTimersByTimeAsync(400);
  f.ads[2].error({ error: { error_code: 30001, error_extra: { token: "secret" } } });
  await vi.runAllTimersAsync(); await run;
  expect(f.create).toHaveBeenCalledTimes(3);
  expect(f.events.at(-1)).toMatchObject({ attempt: 3, source: "onError", errorCode: "30001", showCalled: false });
  expect(JSON.stringify(f.events)).not.toContain("secret");
  expect(f.runner.requiresReopen).toBe(true);
  expect(() => f.runner.showOnce("rewarded", "slot")).toThrow();
  f.runner.dispose();
});

it("创建专测最多二十次，返回实例不记录展示或加载成功", async () => {
  const f = fixture();
  await expect(f.runner.createBurst("rewarded", "slot", 21, 0)).rejects.toThrow();
  const run = f.runner.createBurst("rewarded", "slot", 20, 0);
  await vi.runAllTimersAsync(); await run;
  expect(f.create).toHaveBeenCalledTimes(20);
  expect(f.events.every(e => ["create_call", "instance_returned"].includes(e.source))).toBe(true);
  expect(f.ads.every(a => vi.mocked(a.ad.show).mock.calls.length === 0)).toBe(true);
  f.runner.dispose();
});

it("展示未确认或停止操作都不会释放原生互斥，迟到关闭后才允许继续", async () => {
  const f = fixture();
  f.create.mockImplementationOnce(() => {
    const ad = { show: () => new Promise<void>(() => {}), onError: (cb: (e: unknown) => void) => { error = cb; }, onClose: (cb: (e: { isEnded?: boolean }) => void) => { close = cb; } };
    return ad;
  });
  let close = (_e: { isEnded?: boolean }) => {};
  let error = (_e: unknown) => {};
  f.runner.showOnce("rewarded", "slot");
  f.runner.stop(); await vi.advanceTimersByTimeAsync(15000);
  expect(f.events.at(-1)?.source).toBe("show_unconfirmed");
  expect(f.runner.busy).toBe(true);
  expect(() => f.runner.showOnce("interstitial", "other")).toThrow();
  close({ isEnded: false });
  expect(f.runner.busy).toBe(false);
  f.runner.showOnce("rewarded", "slot");
  error({ error_code: 30001 });
  expect(f.runner.busy).toBe(true); // 旧实例迟到错误不能解除新广告互斥。
  f.ads[0].close({ isEnded: true });
  expect(f.runner.busy).toBe(false);
  f.runner.dispose();
});

it("展示已确认后只计关闭等待未知，不误报展示超时；退出时解绑监听", async () => {
  const f = fixture(); f.runner.showOnce("rewarded", "slot");
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.events.some(e => e.source === "show_unconfirmed")).toBe(false);
  await vi.advanceTimersByTimeAsync(300000);
  expect(f.events.at(-1)?.source).toBe("close_unconfirmed");
  expect(f.runner.busy).toBe(true);
  f.runner.dispose(); const length = f.events.length;
  f.ads[0].error({ error_code: 30001 });
  expect(f.events).toHaveLength(length);
  expect(f.ads[0].ad.offError).toHaveBeenCalled();
  expect(f.ads[0].ad.offClose).toHaveBeenCalled();
});

it("SDK 全局拒绝只记录观察时调用数，不伪造实例归属，且停止后续创建", async () => {
  const f = fixture(); const run = f.runner.createBurst("rewarded", "slot", 20, 200);
  await vi.advanceTimersByTimeAsync(400);
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: { error_code: 30001, error_msg: "Too frequent", token: "secret" } });
  window.dispatchEvent(event);
  await vi.runAllTimersAsync(); await run;
  expect(f.create).toHaveBeenCalledTimes(3);
  expect(f.events.at(-1)).toMatchObject({ attempt: 0, source: "unhandled_rejection", observedAfterCreates: 3, errorCode: "30001" });
  expect(f.events.at(-1)?.showCalled).toBeUndefined();
  expect(JSON.stringify(f.events)).not.toContain("secret");
  f.runner.dispose();
});

it("末实例探测通过公开 show 转发初始化失败，保留原序号且不新增创建", async () => {
  const f = fixture(); const run = f.runner.createBurst("rewarded", "slot", 3, 200);
  await vi.runAllTimersAsync(); await run;
  vi.mocked(f.ads[2].ad.show).mockRejectedValue({ error_code: 30001, error_msg: "Ad placement frequency control" });
  expect(f.runner.canProbe).toBe(true); f.runner.probeLastCreated(); await Promise.resolve();
  expect(f.create).toHaveBeenCalledTimes(3);
  expect(f.events.at(-1)).toMatchObject({ attempt: 3, source: "show_rejected", showCalled: true, errorCode: "30001" });
  expect(f.runner.canProbe).toBe(false);
  f.runner.dispose();
});
