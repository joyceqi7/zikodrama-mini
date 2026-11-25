import { afterEach, expect, it, vi } from "vitest";
import { PlaybackCache } from "./playbackCache";
import type { PlayResolveResult } from "../domain/types";
import { HttpMiniDramaApi } from "../api/httpMiniDramaApi";
import { remainingServerTime } from "../domain/serverTime";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("设备时间改变不延长或提前清空二十秒缓存，真实单调时长到期后重新验权", async () => {
  vi.useFakeTimers();
  const cache = new PlaybackCache();
  const request = vi.fn(async (): Promise<PlayResolveResult> => ({ status: "unavailable" }));
  const first = cache.resolve("app:user", "drama", "episode", request);
  await first;
  vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
  expect(cache.resolve("app:user", "drama", "episode", request)).toBe(first);
  vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(cache.resolve("app:user", "drama", "episode", request)).not.toBe(first);
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
});

it("首页预取与进页共用在途授权，过期后重新验权", async () => {
  vi.useFakeTimers();
  const cache = new PlaybackCache();
  let finish!: (result: PlayResolveResult) => void;
  const request = vi.fn(() => new Promise<PlayResolveResult>(resolve => { finish = resolve; }));
  const first = cache.resolve("app:user", "drama", "episode", request);
  const second = cache.resolve("app:user", "drama", "episode", request);
  expect(second).toBe(first);
  await Promise.resolve();
  finish({ status: "unavailable" });
  await first;
  expect(cache.resolve("app:user", "drama", "episode", request)).toBe(first);
  expect(request).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(20_001);
  const refreshed = cache.resolve("app:user", "drama", "episode", request);
  expect(refreshed).not.toBe(first);
  await Promise.resolve();
  finish({ status: "unavailable" });
  await refreshed;
  expect(request).toHaveBeenCalledTimes(2);
});

it("不同主体不能共享授权，权益失效后的迟到结果被拒绝", async () => {
  const cache = new PlaybackCache();
  let finish!: (result: PlayResolveResult) => void;
  const old = cache.resolve("app:A", "d", "e", () => new Promise(resolve => { finish = resolve; }));
  const rejected = expect(old).rejects.toMatchObject({ code: "identity_changed" });
  await Promise.resolve();
  cache.clear();
  const request = vi.fn(async (): Promise<PlayResolveResult> => ({ status: "unavailable" }));
  await cache.resolve("app:B", "d", "e", request);
  finish({ status: "unavailable" });
  await rejected;
  await cache.resolve("app:A", "d", "e", request);
  expect(request).toHaveBeenCalledTimes(2);
});

it("失败预取不缓存，进页可以重新请求", async () => {
  const cache = new PlaybackCache();
  const request = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ status: "unavailable" });
  await expect(cache.resolve("a", "d", "e", request)).rejects.toThrow("network");
  await expect(cache.resolve("a", "d", "e", request)).resolves.toEqual({ status: "unavailable" });
  expect(request).toHaveBeenCalledTimes(2);
});


it("同账号领奖使在途授权失效时合并最新验权，不误报身份变化或返回旧权益", async () => {
  const cache = new PlaybackCache();
  let finish!: (result: PlayResolveResult) => void;
  const request = vi.fn(() => new Promise<PlayResolveResult>(resolve => { finish = resolve; }));
  const old = cache.resolve("app:A", "d", "e", request);
  await Promise.resolve();
  cache.clear(false);
  const latest: PlayResolveResult = { status: "unavailable" };
  const fresh = vi.fn(async () => latest);
  const current = cache.resolve("app:A", "d", "e", fresh);
  finish({ status: "unavailable" });
  expect(await old).toBe(latest);
  expect(await current).toBe(latest);
  expect(fresh).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
});

it("权益刷新后尚无新请求时主动重新验权", async () => {
  const cache = new PlaybackCache();
  let finish!: (result: PlayResolveResult) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ status: "unavailable" });
  const old = cache.resolve("app:A", "d", "e", request);
  await Promise.resolve();
  cache.clear(false);
  finish({ status: "unavailable" });
  await expect(old).resolves.toEqual({ status: "unavailable" });
  expect(request).toHaveBeenCalledTimes(2);
});

it("广告回前台撤销旧时间基准，在途直连响应校验失败后合并当前代次的新授权", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const serverTime = "2026-10-25T06:35:07Z";
  const playable = { status: "playable", drama: { id: "5" }, episode: { id: "133" }, playback: {
    vid: "fixture-vid", playAuthToken: "fixture-private-token", expiresAt: "2026-10-25T06:40:07Z",
  } };
  const response = () => new Response(JSON.stringify({ code: 0, serverTime, data: playable }));
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementation(async () => response());
  const api = new HttpMiniDramaApi("https://fixture.invalid", fetcher);
  api.configurePlayback({ playbackSdk: { provider: "byteplus_web" } } as Parameters<typeof api.configurePlayback>[0]);
  const cache = new PlaybackCache();
  const request = () => api.resolvePlay("5", "133");
  const old = cache.resolve("app:A", "5", "133", request);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(cache.getPlayable("app:A", "5", "133")).toBeUndefined();
  // 容器 show 信号可能晚于入剧结算；旧响应仍应拒绝，但页面应等待同账号的新验权。
  api.invalidateTime();
  cache.clear(false);
  const current = cache.resolve("app:A", "5", "133", request);
  finish(response());
  await expect(old).resolves.toBe(await current);
  const fresh = await current;
  if (fresh.status !== "playable") throw new Error("缺少直连授权");
  expect(remainingServerTime(fresh.playback)).toBeGreaterThan(290_000);
  expect(cache.getPlayable("app:A", "5", "133")).toBe(fresh);
  expect(cache.getPlayable("app:B", "5", "133")).toBeUndefined();
  api.invalidateTime();
  expect(cache.getPlayable("app:A", "5", "133")).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warning.mock.calls)).not.toContain("fixture-private-token");
  warning.mockRestore();
});

it("换号后失败的旧请求不能重试到旧主体，也不能覆盖新主体缓存", async () => {
  const cache = new PlaybackCache();
  let fail!: (reason: Error) => void;
  const oldRequest = vi.fn(() => new Promise<PlayResolveResult>((_resolve, reject) => { fail = reject; }));
  const old = cache.resolve("app:A", "d", "e", oldRequest);
  const rejected = expect(old).rejects.toMatchObject({ code: "identity_changed" });
  await Promise.resolve();
  cache.clear();
  const current = cache.resolve("app:B", "d", "e", async () => ({ status: "unavailable" }));
  fail(new Error("old request failed"));
  await rejected;
  await expect(current).resolves.toEqual({ status: "unavailable" });
  expect(oldRequest).toHaveBeenCalledOnce();
});

it("旧请求失效后尚无新验权时重新查询，新代次真实失败只返回一次而不循环重试", async () => {
  const cache = new PlaybackCache();
  let fail!: (reason: Error) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockRejectedValue(new Error("current request failed"));
  const old = cache.resolve("app:A", "d", "e", request);
  const rejected = expect(old).rejects.toThrow("current request failed");
  await Promise.resolve();
  cache.clear(false);
  fail(new Error("superseded response"));
  await rejected;
  expect(request).toHaveBeenCalledTimes(2);
});
