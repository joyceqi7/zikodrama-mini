import { afterEach, expect, it, vi } from "vitest";
import { ServerClock, parseServerTimestamp, remainingServerTime } from "./serverTime";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([-86_400_000, -600_000, 600_000, 86_400_000])("手机偏差 %s 毫秒不影响期限，往返耗时从可用时间中保守扣除", offset => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-23T12:00:00Z") + offset);
  let monotonic = 1600;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const clock = new ServerClock();
  const state = clock.bind({ validUntil: "2026-10-23T12:01:00Z" }, "2026-10-23T12:00:00Z", 1000, clock.generation, 1);
  expect(remainingServerTime(state)).toBe(59_400);
  vi.setSystemTime(Date.parse("2036-01-01T00:00:00Z"));
  monotonic += 500;
  expect(remainingServerTime(state)).toBe(58_900);
  expect(clock.now()).toBe(Date.parse("2026-10-23T12:00:00Z") + 500);
});

it("缺失或无效服务器基准时保持未确认，不回退手机时间；无时区期限也拒绝", () => {
  for (const base of [undefined, "invalid", "2026-10-23T12:00:00", "2026-02-30T12:00:00Z", "2026-10-23T24:00:00Z"]) {
    const clock = new ServerClock();
    const value = clock.bind({ expiresAt: "2026-10-23T12:01:00Z" }, base, performance.now(), clock.generation, 1);
    expect(remainingServerTime(value)).toBeUndefined();
    expect(clock.now()).toBeUndefined();
  }
  expect(parseServerTimestamp("2026-10-23T12:01:00")).toBeUndefined();
});

it("前后台或换号即使单调时钟暂停，旧对象和后台迟到响应仍失效；其他 API 实例独立", () => {
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const clock = new ServerClock(), other = new ServerClock();
  const base = "2026-10-23T12:00:00Z";
  const raw = () => ({ expiresAt: "2026-10-23T12:01:00Z" });
  const first = clock.bind(raw(), base, 1000, clock.generation, 1);
  const isolated = other.bind(raw(), base, 1000, other.generation, 1);
  const oldGeneration = clock.generation;
  clock.invalidate();
  expect(remainingServerTime(first)).toBe(0);
  expect(clock.now()).toBeUndefined();
  const late = clock.bind(raw(), base, 1000, oldGeneration, 2);
  expect(remainingServerTime(late)).toBe(0);
  expect(remainingServerTime(isolated)).toBe(60_000);
  const current = clock.bind(raw(), base, 1000, clock.generation, 3);
  clock.changeIdentity(current);
  expect(remainingServerTime(current)).toBe(60_000);
  expect(remainingServerTime(first)).toBe(0);
});

it("批量、VIP 和领奖内许可都使用自身响应基准，后来的响应不延长旧截止点", () => {
  let monotonic = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const clock = new ServerClock();
  const value = clock.bind({ vipState: { active: true, adCount: 1, validUntil: "2026-10-23T12:00:30Z" },
    playback: { playback: { expiresAt: "2026-10-23T12:01:00Z" } } }, "2026-10-23T12:00:00Z", 1000, clock.generation, 1);
  monotonic = 11_000;
  clock.bind([{ expiresAt: "2026-10-23T12:02:00Z" }], "2026-10-23T12:00:10Z", 11_000, clock.generation, 2);
  expect(remainingServerTime(value.vipState)).toBe(20_000);
  expect(remainingServerTime(value.playback.playback)).toBe(50_000);
});
