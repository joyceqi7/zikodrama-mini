import { afterEach, expect, it, vi } from "vitest";
import { foregroundTimeout } from "./foregroundTimeout";
import type { TikTokMinisSDK } from "./types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("只累计前台时间，重复隐藏信号和手机日期跳变不提前超时", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const expired = vi.fn();
  foregroundTimeout(expired, 1000);
  await vi.advanceTimersByTimeAsync(400);
  visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pagehide"));
  await vi.advanceTimersByTimeAsync(60_000);
  vi.setSystemTime(new Date("2040-01-01"));
  expect(expired).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(expired).not.toHaveBeenCalled(); // pagehide 后网页 visible 不能替代 pageshow。
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(599);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledOnce();
});

it("原生隐藏与网页隐藏必须都恢复；结束后取消当前订阅但保留页面监听且不再次计时", async () => {
  vi.useFakeTimers();
  const events = new Map<string, () => void>();
  const sdk = { on: vi.fn((event, listener) => { events.set(event, listener); return event; }), off: vi.fn() } as unknown as TikTokMinisSDK;
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const expired = vi.fn();
  const stop = foregroundTimeout(expired, 1000, sdk);
  events.get("minis.hide")!();
  visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
  events.get("minis.show")!();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(expired).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(500);
  stop(); stop();
  expect(sdk.off).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(expired).not.toHaveBeenCalled();
});
