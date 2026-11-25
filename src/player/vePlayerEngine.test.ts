import { ServerClock } from "../domain/serverTime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DirectVePlayerAdapter,
  directPlayerOptions,
  validateDirectSource,
} from "./vePlayerEngine";
import { officialPlayerOptions } from "./tiktokMinisPlayerEngine";
import type { PlaybackSource } from "./playbackEngine";
import type { TikTokVePlayerOptions } from "../platform/tiktok/types";
import { selectVePlayerLicense } from "./vePlayerLicense";
import configuration from "../config/veplayer-licenses.json";
import { DirectPlayerExemptionRejected } from "../platform/tiktok/directPlayerExemption";

const license = vi.hoisted(() => vi.fn(async (_configuration: unknown) => {}));
const exemption = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../platform/tiktok/directPlayerExemption", async importOriginal => ({
  ...await importOriginal<typeof import("../platform/tiktok/directPlayerExemption")>(),
  ensureDirectPlayerExemption: exemption,
}));
const createdOptions = vi.hoisted(() => vi.fn<(options: TikTokVePlayerOptions) => void>());
const destroyed = vi.hoisted(() => vi.fn());
const playerListeners = vi.hoisted(() => new Map<string, (payload?: unknown) => void>());
const prefetch = vi.hoisted(() => vi.fn<(sources: TikTokVePlayerOptions[]) => Promise<{ status: string; error?: { message?: string } }[]>>());
const clearMediaInfo = vi.hoisted(() => vi.fn());
vi.mock("@byteplus/veplayer", () => ({
  default: class {
    static setLicenseConfig = license;
    static prefetchMediaInfo = prefetch;
    static clearMediaInfoCache = clearMediaInfo;
    constructor(options: TikTokVePlayerOptions) { createdOptions(options); }
    on(event: string, callback: (payload?: unknown) => void) { playerListeners.set(event, callback); }
    off(event: string) { playerListeners.delete(event); }
    playNext(options: TikTokVePlayerOptions) { createdOptions(options); return Promise.resolve(); }
    destroy() { destroyed(); }
  },
}));
vi.mock("@byteplus/veplayer/index.min.css", () => ({}));
const originalWindow = window;
const installPageHost = (hostname: string) => vi.stubGlobal("window", new Proxy(originalWindow, {
  get(target, property) {
    return property === "top" ? { location: { hostname } } : Reflect.get(target, property, target);
  },
}));
const source = (changes: Partial<PlaybackSource> = {}): PlaybackSource => new ServerClock().bind({
  provider: "byteplus_web",
  channel: "byteplus",
  vid: "direct-vid",
  playAuthToken: "temporary-test-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...changes,
}, new Date().toISOString(), performance.now(), 0, 0);
beforeEach(() => {
  license.mockReset().mockResolvedValue(undefined);
  exemption.mockReset().mockResolvedValue(undefined);
  createdOptions.mockClear();
  destroyed.mockClear();
  playerListeners.clear();
  prefetch.mockReset().mockResolvedValue([{ status: "fulfilled" }]);
  clearMediaInfo.mockClear();
  installPageHost("mini.tiktok-minis.us");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("基础版只传 VID 和短时授权，不要求官方映射或转码清晰度", () => {
  const options = directPlayerOptions(
    source(),
    document.createElement("div"),
    "12345",
  );
  expect(options).toMatchObject({
    vid: "direct-vid",
    getVideoByToken: {
      playAuthToken: "temporary-test-token",
      needPoster: true,
    },
    enableMp4MSE: false,
    vodLogOpts: { line_app_id: 12345 },
  });
  for (const key of [
    "albumId",
    "episodeId",
    "url",
    "definition",
    "playList",
    "enablePreload",
  ])
    expect(options).not.toHaveProperty(key);
  expect(() => officialPlayerOptions(source())).toThrow();
});
it("媒体信息回调只记录 VID、SDK AppID 与缓存标记，不记录响应内容", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const options = directPlayerOptions(source(), undefined, "12345");
  options.onGetMediaInfo?.({ fromCache: true, playAuthToken: "private-token", url: "https://private.test/video" } as { fromCache: boolean });
  expect(log).toHaveBeenCalledExactlyOnceWith({ event: "direct_player_media_info_ready", vid: "direct-vid", sdkAppId: "12345", fromCache: true, elapsedMs: expect.any(Number) });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});
it.each([false, true])("首集媒体开始加载后才调度下一集信息，授权先到=%s", async authorizedFirst => {
  const adapter = new DirectVePlayerAdapter();
  const engine = adapter.createEngine();
  const first = source();
  const next = source({ vid: "next-vid" });
  const onFirstFrame = vi.fn();
  const onPlay = vi.fn();
  const prepareNext = vi.fn(() => adapter.prefetchMediaInfo(next, "next_episode"));
  try {
    await engine.mount(document.createElement("div"), first, { onFirstFrame, onPlay });
    if (authorizedFirst) engine.whenInitialMediaLoading(first.vid, prepareNext);
    await Promise.resolve();
    expect(prefetch).not.toHaveBeenCalled();
    playerListeners.get("loadstart")?.();
    if (!authorizedFirst) engine.whenInitialMediaLoading(first.vid, prepareNext);
    await vi.waitFor(() => expect(prefetch).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ vid: next.vid })]));
    playerListeners.get("loadstart")?.();
    await Promise.resolve();
    expect(prepareNext).toHaveBeenCalledOnce();
    expect(onFirstFrame).not.toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
  } finally { engine.destroy(); }
});

it.each(["switch", "destroy"])("切走或销毁首集时丢弃已排队的预取，动作为 %s", async action => {
  const adapter = new DirectVePlayerAdapter();
  const engine = adapter.createEngine();
  const first = source();
  const prepareNext = vi.fn();
  try {
    await engine.mount(document.createElement("div"), first);
    engine.whenInitialMediaLoading(first.vid, prepareNext);
    playerListeners.get("loadstart")?.();
    if (action === "switch") await engine.switchSource(source({ vid: "next-vid" }));
    else engine.destroy();
    await Promise.resolve();
    expect(prepareNext).not.toHaveBeenCalled();
  } finally { engine.destroy(); }
});

it("临近起播才发出的预取不延迟挂载和切集，授权参数与实际播放一致", async () => {
  const adapter = new DirectVePlayerAdapter();
  const first = source();
  const next = source({ vid: "next", playAuthToken: "next-test-token" });
  adapter.prefetchMediaInfo(first, "launch");
  expect(prefetch).not.toHaveBeenCalled();

  await adapter.getConstructor();
  let finish!: () => void;
  prefetch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([{ status: "fulfilled" }]); }));
  adapter.prefetchMediaInfo(first, "launch");
  adapter.prefetchMediaInfo(first, "launch");
  adapter.prefetchMediaInfo(source({ expiresAt: new Date(Date.now() - 1).toISOString() }), "next_episode");
  await Promise.resolve();
  const engine = adapter.createEngine();
  try {
    await expect(engine.mount(document.createElement("div"), first)).resolves.toBe(true);
    expect(prefetch).toHaveBeenCalledExactlyOnceWith([{
      vid: first.vid, getVideoByToken: createdOptions.mock.calls[0][0].getVideoByToken,
    }]);
    adapter.prefetchMediaInfo(next, "next_episode");
    await Promise.resolve();
    await engine.switchSource(next);
    expect(prefetch).toHaveBeenLastCalledWith([{
      vid: next.vid, getVideoByToken: createdOptions.mock.calls[1][0].getVideoByToken,
    }]);
  } finally { finish?.(); engine.destroy(); }
});

it("首集与切集优先接管同轮尚未发出的预取", async () => {
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  const engine = adapter.createEngine();
  const first = source();
  const next = source({ vid: "next", playAuthToken: "next-test-token" });
  try {
    adapter.prefetchMediaInfo(first, "launch");
    await expect(engine.mount(document.createElement("div"), { ...first })).resolves.toBe(true);
    adapter.prefetchMediaInfo(next, "next_episode");
    await engine.switchSource({ ...next });
    expect(prefetch).not.toHaveBeenCalled();
    expect(createdOptions).toHaveBeenCalledTimes(2);
    expect(createdOptions).toHaveBeenLastCalledWith(expect.objectContaining({ vid: "next" }));
  } finally { engine.destroy(); }
});

it.each(["launch", "next_episode"] as const)("%s 复用已领先的同份授权，预取成功就交给播放器", async stage => {
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  vi.useFakeTimers();
  const playback = source({ vid: "target-vid" });
  const engine = adapter.createEngine();
  let finish!: () => void;
  prefetch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([{ status: "fulfilled" }]); }));
  try {
    if (stage === "next_episode") await engine.mount(document.createElement("div"), source({ vid: "previous-vid" }));
    const optionsBefore = createdOptions.mock.calls.length;
    adapter.prefetchMediaInfo(playback, stage);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    const start = stage === "launch"
      ? engine.mount(document.createElement("div"), { ...playback })
      : engine.switchSource({ ...playback });

    await vi.advanceTimersByTimeAsync(70);
    expect(createdOptions).toHaveBeenCalledTimes(optionsBefore);
    finish();
    await start;
    expect(prefetch).toHaveBeenCalledOnce();
    expect(createdOptions).toHaveBeenCalledTimes(optionsBefore + 1);
    expect(createdOptions).toHaveBeenLastCalledWith(expect.objectContaining({ vid: playback.vid }));
  } finally { finish?.(); engine.destroy(); }
});

it("按预取发起时刻计算截止，超出剩余窗口后直接挂载", async () => {
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  vi.useFakeTimers();
  const playback = source();
  const engine = adapter.createEngine();
  let finish!: () => void;
  prefetch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([{ status: "fulfilled" }]); }));
  try {
    adapter.prefetchMediaInfo(playback, "launch");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    const mounting = engine.mount(document.createElement("div"), playback);
    await vi.advanceTimersByTimeAsync(69);
    expect(createdOptions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(mounting).resolves.toBe(true);
    expect(prefetch).toHaveBeenCalledOnce();
  } finally { finish?.(); engine.destroy(); }
});

it("在途预取失败立即释放首集，授权失效时不挂载", async () => {
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  vi.useFakeTimers();
  const playback = source();
  const engine = adapter.createEngine();
  let fail!: () => void;
  prefetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("Fixture media lookup failed")); }));
  try {
    adapter.prefetchMediaInfo(playback, "launch");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    const mounting = engine.mount(document.createElement("div"), playback);
    expect(createdOptions).not.toHaveBeenCalled();
    fail();
    await expect(mounting).resolves.toBe(true);
    expect(createdOptions).toHaveBeenCalledOnce();

    const replacement = source({ vid: "expired-target", playAuthToken: "fixture-expired" });
    let finishOld!: () => void;
    prefetch.mockImplementationOnce(() => new Promise(resolve => {
      finishOld = () => resolve([{ status: "fulfilled" }]);
    }));
    adapter.prefetchMediaInfo(replacement, "next_episode");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    const switching = expect(engine.switchSource(replacement)).rejects.toThrow(/Playback authorization/);
    replacement.serverDeadline!.context.value++;
    adapter.clearMediaInfoCache();
    await switching;
    finishOld();
    expect(createdOptions).toHaveBeenCalledOnce();
  } finally { engine.destroy(); }
});

it("快速切到其他集时无需等上一次交接，不安装已离开的分集", async () => {
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  vi.useFakeTimers();
  const first = source();
  const stale = source({ vid: "stale-target", playAuthToken: "stale-target-token" });
  const next = source({ vid: "latest-target", playAuthToken: "latest-target-token" });
  const engine = adapter.createEngine();
  let finish!: () => void;
  prefetch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([{ status: "fulfilled" }]); }));
  try {
    await engine.mount(document.createElement("div"), first);
    adapter.prefetchMediaInfo(stale, "next_episode");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);
    const oldSwitch = engine.switchSource(stale);
    await engine.switchSource(next);
    expect(createdOptions.mock.calls.map(([options]) => options.vid)).toEqual([first.vid, next.vid]);
    finish();
    await oldSwitch;
    expect(createdOptions).toHaveBeenCalledTimes(2);
  } finally { finish?.(); engine.destroy(); }
});

it("作废预取后清除迟到结果，新一轮预取使用新授权", async () => {
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  let finish!: () => void;
  prefetch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([{ status: "fulfilled" }]); }));
  adapter.prefetchMediaInfo(source(), "launch");
  await vi.waitFor(() => expect(prefetch).toHaveBeenCalledOnce());
  adapter.clearMediaInfoCache();
  expect(clearMediaInfo).toHaveBeenCalledOnce();
  const next = source({ vid: "fresh-video", playAuthToken: "new-visitor-token" });
  adapter.prefetchMediaInfo(next, "launch");
  expect(prefetch).toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() => expect(clearMediaInfo).toHaveBeenCalledTimes(2));
  adapter.prefetchMediaInfo(next, "launch");
  await vi.waitFor(() => expect(prefetch).toHaveBeenCalledTimes(2));
});

it("预取失败记录脱敏错误，可继续使用相同授权正常挂载", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const adapter = new DirectVePlayerAdapter();
  await adapter.getConstructor();
  const playback = source();
  prefetch.mockResolvedValueOnce([{
    status: "rejected", error: { message: "VOD request failed for temporary-test-token https://video.example/signed" },
  }]);
  adapter.prefetchMediaInfo(playback, "launch");
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith({
    event: "direct_media_info_prefetch_failed", stage: "launch", vid: playback.vid,
    error: "VOD request failed for [REDACTED] [URL]",
  }));
  const engine = adapter.createEngine();
  try { await expect(engine.mount(document.createElement("div"), playback)).resolves.toBe(true); }
  finally { engine.destroy(); }
});

it("过期授权、官方源和伪造官方映射均拒绝，不使用替代播放器", () => {
  for (const changes of [
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { expiresAt: "invalid" },
    { playAuthToken: "" },
    { provider: "tiktok_minis" as const },
    { albumId: "fake" },
    { episodeId: "fake" },
  ])
    expect(() => validateDirectSource(source(changes))).toThrow();
});
it("使用原始 License 与 mainUrl，同页多个适配器只验证一次并等待完成", async () => {
  let ready!: () => void;
  license.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const adapter = new DirectVePlayerAdapter();
  const first = adapter.getConstructor();
  const other = new DirectVePlayerAdapter().getConstructor();
  expect(adapter.getConstructor()).toBe(first);
  let completed = false;
  void first.then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(license).toHaveBeenCalledOnce());
  const expected = selectVePlayerLicense("mini.tiktok-minis.us").license;
  expect(JSON.stringify(license.mock.calls[0]?.[0]) === JSON.stringify({ license: expected })).toBe(true);
  expect(completed).toBe(false);
  ready();
  await first;
  await other;
  await adapter.getConstructor();
  await new DirectVePlayerAdapter().getConstructor();
  expect(license).toHaveBeenCalledOnce();
});
it("包内独立 SDK 在页面校验等待期间加载，许可和播放器仍等待校验完成", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  let ready!: () => void;
  exemption.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const pending = new DirectVePlayerAdapter().getConstructor();
  const completed = vi.fn();
  void pending.then(completed);
  await vi.waitFor(() => expect(exemption).toHaveBeenCalledOnce());
  try {
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "direct_player_sdk_loaded" })));
    expect(completed).not.toHaveBeenCalled();
    expect(license).not.toHaveBeenCalled();
    expect(createdOptions).not.toHaveBeenCalled();
  } finally {
    ready();
    await expect(pending).resolves.toBeTypeOf("function");
  }
  expect(license).toHaveBeenCalledOnce();
});
it("播放豁免失败记录脱敏错误并阻止许可初始化，重试可恢复", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  exemption.mockRejectedValueOnce(new Error("video verification failed https://private.example/?token=secret token=credential"));
  const adapter = new DirectVePlayerAdapter();
  await expect(adapter.getConstructor()).rejects.toThrow("video verification failed [URL] token=[REDACTED]");
  expect(license).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    event: "direct_player_initialization_failed", error: "video verification failed [URL] token=[REDACTED]",
  }));
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|credential|https:\/\//);
  await expect(adapter.getConstructor()).resolves.toBeTypeOf("function");
});
it("平台显式拒绝按预期拒绝记录，保持调用失败且不创建播放器", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  exemption.mockRejectedValueOnce(new DirectPlayerExemptionRejected());
  await expect(new DirectVePlayerAdapter().getConstructor()).rejects.toThrow("explicitly rejects independent playback");
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    event: "direct_player_initialization_failed", error: "TikTok explicitly rejects independent playback for this Mini",
  }));
  expect(error).not.toHaveBeenCalled();
  expect(license).not.toHaveBeenCalled();
  expect(createdOptions).not.toHaveBeenCalled();
});
it("许可失败后可重试，诊断记录不泄露 URL 或 Token", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const selected = selectVePlayerLicense("mini.tiktok-minis.us");
  license.mockRejectedValueOnce(
    new Error(
      `license verification failed https://license.example/private?token=secret token=credential ${selected.license.content} ${selected.license.sign}`,
    ),
  );
  const adapter = new DirectVePlayerAdapter();
  await expect(adapter.getConstructor()).rejects.toThrow("license");
  const diagnostics = JSON.stringify(log.mock.calls);
  expect(diagnostics).not.toContain("secret");
  expect(diagnostics).not.toContain("credential");
  expect(diagnostics).not.toContain("https://");
  expect(diagnostics).not.toContain(selected.license.content);
  expect(diagnostics).not.toContain(selected.license.sign);
  expect(diagnostics).toContain("license verification failed");
  expect(log).toHaveBeenCalledOnce();
  await expect(adapter.getConstructor()).resolves.toBeTypeOf("function");
  expect(license).toHaveBeenCalledTimes(2);
  log.mockRestore();
});

it.each(configuration.domains)("$domain 创建与切集都使用对应的 SDK AppID", async ({ domain, appId }) => {
  installPageHost(`mini.${domain}`);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const engine = new DirectVePlayerAdapter().createEngine();
  expect(await engine.mount(document.createElement("div"), source())).toBe(true);
  await engine.switchSource(source({ vid: "next-vid" }));
  const expected = selectVePlayerLicense(`mini.${domain}`).license;
  expect(JSON.stringify(license.mock.calls[0]?.[0]) === JSON.stringify({ license: expected })).toBe(true);
  expect(createdOptions).toHaveBeenCalledTimes(2);
  for (const [options] of createdOptions.mock.calls) expect(options).toMatchObject({ vodLogOpts: { line_app_id: Number(appId) } });
  engine.destroy();
  expect(destroyed).toHaveBeenCalledOnce();
  expect(log).not.toHaveBeenCalled();
});

it("顶层不可读或域名未知时不调用 SDK 并记录具体错误", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  installPageHost("unknown.example");
  await expect(new DirectVePlayerAdapter().getConstructor()).rejects.toThrow("No VePlayer license");
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get(target, property) {
      if (property === "top") throw new Error("Blocked a frame with origin https://private.example/?token=secret");
      return Reflect.get(target, property, target);
    },
  }));
  await expect(new DirectVePlayerAdapter().getConstructor()).rejects.toThrow("Cannot read top-level");
  expect(license).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(log.mock.calls)).toContain("Blocked a frame with origin [URL]");
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});

it("超时后重试不并发配置许可，迟到验证完成后可正常取得构造器", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let ready!: () => void;
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  license.mockImplementationOnce(() => { started(); return new Promise<void>(resolve => { ready = resolve; }); });
  const adapter = new DirectVePlayerAdapter();
  const first = expect(adapter.getConstructor()).rejects.toThrow("timed out");
  await called;
  await vi.advanceTimersByTimeAsync(15_000);
  await first;
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]?.[0]).toMatchObject({ event: "direct_player_initialization_failed", error: "Direct player initialization timed out" });
  const retry = adapter.getConstructor();
  const other = new DirectVePlayerAdapter().getConstructor();
  ready();
  await expect(retry).resolves.toBeTypeOf("function");
  await expect(other).resolves.toBeTypeOf("function");
  expect(license).toHaveBeenCalledOnce();
});

it("超时后的 SDK 实际失败只记录一次并允许重新验签", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let rejectLicense!: (reason: Error) => void;
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  license.mockImplementationOnce(() => { started(); return new Promise<void>((_, reject) => { rejectLicense = reject; }); });
  const first = expect(new DirectVePlayerAdapter().getConstructor()).rejects.toThrow("timed out");
  await called;
  await vi.advanceTimersByTimeAsync(15_000);
  await first;
  rejectLicense(new Error("SDK license verification failed"));
  await vi.advanceTimersByTimeAsync(0);
  await expect(new DirectVePlayerAdapter().getConstructor()).resolves.toBeTypeOf("function");
  expect(license).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[1]?.[0]).toMatchObject({ error: "SDK license verification failed" });
});
