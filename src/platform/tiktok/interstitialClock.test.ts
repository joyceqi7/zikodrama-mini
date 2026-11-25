import { afterEach, expect, it, vi } from "vitest";
import { FullscreenAdGate } from "./interstitialAd";
import { adPolicy } from "../../config/adPolicy";

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("同页重建广告门禁共享单调间隔，修改手机日期不能提前请求或无限延后", () => {
  vi.useFakeTimers(); sessionStorage.clear();
  const first = new FullscreenAdGate("clock-current-page");
  vi.advanceTimersByTime(adPolicy.interstitialStartupDelayMs);
  const release = first.acquire(true);
  expect(release).toBeTypeOf("function"); release!();
  const rebuilt = new FullscreenAdGate("clock-current-page");
  vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
  expect(rebuilt.acquire(true)).toBeUndefined();
  vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
  vi.advanceTimersByTime(adPolicy.interstitialIntervalMs);
  expect(rebuilt.acquire(true)).toBeTypeOf("function");
});

it("新页面不比较历史时间原点，有历史标记时最多等待一个配置间隔", () => {
  vi.useFakeTimers(); sessionStorage.clear();
  sessionStorage.setItem("minis-fullscreen-ad:clock-new-page", "999999999999999");
  const gate = new FullscreenAdGate("clock-new-page");
  vi.advanceTimersByTime(adPolicy.interstitialIntervalMs - 1);
  expect(gate.acquire(true)).toBeUndefined();
  vi.advanceTimersByTime(1);
  expect(gate.acquire(true)).toBeTypeOf("function");
  expect(sessionStorage.getItem("minis-fullscreen-ad:clock-new-page")).toBe("1");
});
