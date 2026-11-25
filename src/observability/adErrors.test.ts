import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { adErrorPolicy } from "../config/adErrorPolicy";
import { AdErrorReporter, type AdErrorEvent } from "./adErrors";
import type { AdMetricDetails, AdObservation } from "./adMetrics";

const metadata: Omit<AdMetricDetails, keyof AdObservation> = { adType: "rewarded", adUnitId: "slot", scene: "entry_reward", clientVersion: "build", os: "ios", tiktokVersion: "46.1" };
const failure: AdObservation = { kind: "ad_failure", stage: "show", reason: "container_unavailable", subErrorCode: "50008", failure: { error: "container unavailable", errorDocument: "visible", errorNative: "unknown", errorPrerender: false, shown: false, userInitiated: false } };
const reporters: AdErrorReporter[] = [];
function reporter(send: (events: AdErrorEvent[]) => Promise<unknown>) {
  const instance = new AdErrorReporter(send);
  instance.identify("A"); reporters.push(instance);
  return instance;
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { reporters.splice(0).forEach(value => value.dispose()); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("成功、取消、未知和本地拦截不产生请求；同次错误重复回调只入队一次", async () => {
  const send = vi.fn<(events: AdErrorEvent[]) => Promise<unknown>>(async () => {}), instance = reporter(send);
  const observe = instance.capture(metadata, "ad-call-1234567890");
  for (const kind of ["ad_trigger", "ad_shown", "ad_cancelled", "ad_skipped", "ad_show_unknown"] as const) observe({ ...failure, kind });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const detail = { ...failure.failure! };
  observe({ ...failure, failure: detail }); observe(failure);
  detail.error = "mutated";
  await vi.advanceTimersByTimeAsync(adErrorPolicy.batchDelayMs);
  expect(send).toHaveBeenCalledExactlyOnceWith([{ id: "ad-call-1234567890", ad: { ...metadata, stage: "show", reason: "container_unavailable", subErrorCode: "50008" }, failure: failure.failure }]);
});

it("突发错误短暂合批，队列有界；每十秒最多一请求且每批最多五条", async () => {
  const send = vi.fn<(events: AdErrorEvent[]) => Promise<unknown>>(async () => {}), instance = reporter(send);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 100; i++) instance.capture(metadata, `attempt-example-${i}`)(failure);
  await vi.advanceTimersByTimeAsync(adErrorPolicy.batchDelayMs - 1);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.calls[0][0]).toHaveLength(5);
  await vi.advanceTimersByTimeAsync(adErrorPolicy.minIntervalMs - 1);
  expect(send).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send.mock.calls.flatMap(([events]) => events)).toHaveLength(20);
  expect(send).toHaveBeenCalledTimes(4);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "ad_error_queue_full" }));
});

it.each([401, 429, 503])("接口 %s 失败不重试，保留脱敏本地错误并退避后续批次", async status => {
  const send = vi.fn<(events: AdErrorEvent[]) => Promise<unknown>>().mockRejectedValueOnce(Object.assign(new Error("upload failed token=private"), { status })).mockResolvedValue(undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const instance = reporter(send);
  instance.capture(metadata, "first-attempt-example")(failure);
  await vi.advanceTimersByTimeAsync(adErrorPolicy.batchDelayMs);
  instance.capture(metadata, "next-attempt-example")(failure);
  await vi.advanceTimersByTimeAsync(adErrorPolicy.failureBackoffMs - 1);
  expect(send).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].map(event => event.id)).toEqual(["next-attempt-example"]);
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "ad_error_batch_dropped", error: "upload failed token=[REDACTED]" }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(send).toHaveBeenCalledTimes(2);
});

it("换号清空队列、丢弃旧回调且不绕过发送间隔；在途请求结束不误删新主体现场", async () => {
  let finish!: () => void;
  const send = vi.fn<(events: AdErrorEvent[]) => Promise<unknown>>().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const instance = reporter(send);
  instance.capture(metadata, "a-sending-example")(failure);
  await vi.advanceTimersByTimeAsync(adErrorPolicy.batchDelayMs);
  const stale = instance.capture(metadata, "a-late-callback-example");
  instance.capture(metadata, "a-queued-example")(failure);
  instance.identify("B"); stale(failure);
  instance.capture(metadata, "b-attempt-example")(failure);
  finish(); await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(adErrorPolicy.minIntervalMs - 1);
  expect(send).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.calls[1][0].map(event => event.id)).toEqual(["b-attempt-example"]);
  instance.capture(metadata, "b-before-dispose-example")(failure);
  instance.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenCalledTimes(2);
});
