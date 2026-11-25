import { afterEach, expect, it, vi } from "vitest";
import { OfficialPreloader } from "./preload";
import type { TikTokVePlayerConstructor } from "../platform/tiktok/types";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const sources = [{ vid: "vid", albumId: "album", episodeId: "episode" }];

it("支持 MSE 时复用官方字节列表，不重复请求相同媒体信息", async () => {
  vi.stubGlobal("MediaSource", class {});
  const ctor = Object.assign(class {}, { prepare: vi.fn(async () => {}), setPreloadList: vi.fn(async () => {}), setPreloadScene: vi.fn(), prefetchMediaInfo: vi.fn(), clearMediaInfoCache: vi.fn(), preloader: { clearPreloadList: vi.fn(), removeAllPreloadTask: vi.fn(), removeAll: vi.fn() } });
  const preloader = new OfficialPreloader({ getConstructor: async () => ctor as unknown as TikTokVePlayerConstructor });
  await preloader.update(sources, 0);
  await preloader.update(sources, 1);
  expect(ctor.prepare).toHaveBeenCalledOnce();
  expect(ctor.prepare).toHaveBeenCalledWith({ strategies: { preload: { preloadMaxCacheCount: 5 } } });
  expect(ctor.setPreloadScene).toHaveBeenCalledWith(0, { preloadTime: 5 });
  expect(ctor.setPreloadScene).toHaveBeenLastCalledWith(1, { prevCount: 1, nextCount: 2, preloadTime: 5 });
  expect(ctor.setPreloadList).toHaveBeenCalledWith(sources);
  expect(ctor.prefetchMediaInfo).not.toHaveBeenCalled();
  preloader.clear(true); await Promise.resolve(); await Promise.resolve();
  expect(ctor.preloader.removeAll).toHaveBeenCalledOnce();
  expect(ctor.clearMediaInfoCache).toHaveBeenCalledOnce();
});

it("自动模式更新有序列表时保留正在进行的官方预加载任务", async () => {
  vi.stubGlobal("MediaSource", class {});
  const ctor = Object.assign(class {}, { prepare: vi.fn(async () => {}), setPreloadList: vi.fn(async () => {}), setPreloadScene: vi.fn(), preloader: { clearPreloadList: vi.fn(), removeAllPreloadTask: vi.fn() } });
  const preloader = new OfficialPreloader({ getConstructor: async () => ctor as unknown as TikTokVePlayerConstructor });
  await preloader.update(sources, 1);
  await preloader.update([...sources, { vid: "vid-2", albumId: "album", episodeId: "episode-2" }], 1);
  expect(ctor.preloader.clearPreloadList).toHaveBeenCalledOnce();
  expect(ctor.preloader.removeAllPreloadTask).toHaveBeenCalledOnce();
  expect(ctor.setPreloadList).toHaveBeenCalledTimes(2);
  expect(ctor.setPreloadScene).toHaveBeenCalledOnce();
});

it("能力不完整只预请求媒体信息；离页使等待中的旧候选失效", async () => {
  const ctor = Object.assign(class {}, { prefetchMediaInfo: vi.fn(async () => [{ status: "fulfilled" }]) });
  const preloader = new OfficialPreloader({ getConstructor: async () => ctor as unknown as TikTokVePlayerConstructor });
  const old = preloader.update(sources, 0);
  preloader.clear(true); await old;
  expect(ctor.prefetchMediaInfo).not.toHaveBeenCalled();
  await preloader.update(sources, 1);
  expect(ctor.prefetchMediaInfo).toHaveBeenCalledWith(sources);
});


it("官方初始化失败保留具体脱敏原因，下次可重试且成功不误报", async () => {
  vi.stubGlobal("MediaSource", class {});
  const logging = vi.spyOn(console, "warn").mockImplementation(() => {});
  const prepare = vi.fn().mockRejectedValueOnce(new Error("Preload unavailable token=private-token")).mockResolvedValue(undefined);
  const ctor = Object.assign(class {}, { prepare, setPreloadScene: vi.fn(), setPreloadList: vi.fn(async () => {}) });
  const preloader = new OfficialPreloader({ getConstructor: async () => ctor as unknown as TikTokVePlayerConstructor });
  await preloader.update(sources, 0);
  expect(logging).toHaveBeenCalledWith(expect.objectContaining({event: "media_preload_failed", error: "Preload unavailable token=[REDACTED]"}));
  expect(ctor.setPreloadList).not.toHaveBeenCalled();
  logging.mockClear();
  await preloader.update(sources, 0);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(ctor.setPreloadList).toHaveBeenCalledWith(sources);
  expect(logging).not.toHaveBeenCalled();
});

it("启动准备与候选更新复用初始化，重复 prepare 不清空入口任务", async () => {
  vi.stubGlobal("MediaSource", class {});
  const ctor = Object.assign(class {}, { prepare: vi.fn(async () => {}), setPreloadScene: vi.fn(), setPreloadList: vi.fn(async () => {}), preloader: { removeAllPreloadTask: vi.fn(), clearPreloadList: vi.fn() } });
  const preloader = new OfficialPreloader({ getConstructor: async () => ctor as never });
  await Promise.all([preloader.prepare(), preloader.update([], 0)]);
  const cancellations = ctor.preloader.removeAllPreloadTask.mock.calls.length;
  await preloader.prepare();
  expect(ctor.prepare).toHaveBeenCalledOnce();
  expect(ctor.preloader.removeAllPreloadTask).toHaveBeenCalledTimes(cancellations);
  vi.unstubAllGlobals();
});
