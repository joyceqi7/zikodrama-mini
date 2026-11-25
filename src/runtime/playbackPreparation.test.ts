import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../domain/types";
import { createTikTokFixture } from "../test/tiktokFixture";

const originalWindow = window;

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get(target, property) {
      return property === "top" ? { location: { hostname: "mini.tiktok-minis.us" } } : Reflect.get(target, property, target);
    },
  }));
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  document.head.querySelector('link[rel="preconnect"][href="https://vod.byteplusapi.com"]')?.remove();
  const { disposeVisibilityTracking } = await import("../platform/tiktok/lifecycle");
  disposeVisibilityTracking();
  delete window.TTMinis;
  delete window.__TIKTOK_MINIS_INITIALIZE__;
  delete window.__TIKTOK_MINIS_INITIALIZED__;
  delete window.__TIKTOK_MINIS_CLIENT_KEY__;
  delete window.__ttMinisVideoSecurityInstance;
  vi.doUnmock("@byteplus/veplayer");
  vi.doUnmock("@byteplus/veplayer/index.min.css");
  vi.doUnmock("../player/vePlayerEngine");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// 只替换平台、传输和厂商资源，保留 Runtime、SDK 就绪与页面校验的真实等待关系。
async function preparationFixture(provider: "tiktok_minis" | "byteplus_web", early?: "same-foreground" | "foreground-changed" | "login" | "login-stale") {
  const adapter = vi.fn();
  vi.doMock("../player/vePlayerEngine", async importOriginal => {
    adapter();
    return await importOriginal<typeof import("../player/vePlayerEngine")>();
  });
  const resource = vi.fn();
  const css = vi.fn();
  const license = vi.fn(async () => {});
  const created = vi.fn();
  const prefetch = vi.fn(async () => [{ status: "fulfilled" }]);
  vi.doMock("@byteplus/veplayer", () => {
    resource();
    return { default: class {
      static setLicenseConfig = license;
      static prefetchMediaInfo = prefetch;
      static clearMediaInfoCache = vi.fn();
      constructor() { created(); }
    } };
  });
  vi.doMock("@byteplus/veplayer/index.min.css", () => { css(); return {}; });
  const initialization = deferred();
  const platform = createTikTokFixture();
  window.TTMinis = platform.sdk;
  window.__TIKTOK_MINIS_INITIALIZED__ = false;
  window.__TIKTOK_MINIS_INITIALIZE__ = vi.fn(async () => {
    await initialization.promise;
    window.__TIKTOK_MINIS_INITIALIZED__ = true;
  });
  window.__TIKTOK_MINIS_CLIENT_KEY__ = "test-client-key";
  let verification: Record<string, unknown> = {};
  const security = {
    getConfig: () => ({ appId: "test-client-key", playerVerificationConfig: verification }),
    setPlayerVerificationConfig: vi.fn((next: Record<string, unknown>) => { verification = next; }),
    isClientKeyBlacklisted: () => false,
    isClientKeyWhitelisted: (key: string, value: Record<string, unknown>) => Array.isArray(value.playerWhiteList) && value.playerWhiteList.includes(key),
  };
  window.__ttMinisVideoSecurityInstance = security;
  const config: AppConfig = {
    applicationId: "1", tiktokAppId: "test-app", appName: "Test", logoUrl: "", complianceBaseUrl: "",
    playbackSdk: { provider, channel: "byteplus", ...(provider === "byteplus_web" ? { capabilities: { mediaPreload: false } } : {}) },
    monetization: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 2, requireBeforePlayback: true, title: "", content: "" } },
  };
  const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data, serverTime: new Date().toISOString() }));
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input).split("?")[0];
    if (path.endsWith("/open/app-config")) return response(config);
    if (path.endsWith("/session")) return response({ applicationId: "1", tiktokAppId: "test-app", visitorId: "11", visitorToken: "test-token", identityState: "tiktok_authenticated" });
    if (path.endsWith("/me/vip")) return response({ active: false, adCount: 0, requiredCount: 2, progressDate: "2026-11-18" });
    if (path.endsWith("/metrics")) return response({ accepted: true });
    throw new Error(`测试未配置的请求：${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  if (early) {
    const { prepareInitialAppConfig } = await import("./initialAppConfig");
    const { currentApplicationProfile } = await import("../config/applicationProfile");
    const earlyLogin = early === "login" || early === "login-stale";
    prepareInitialAppConfig(currentApplicationProfile(), earlyLogin ? window.location.search : undefined);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([expect.stringContaining("/open/app-config")]);
    if (earlyLogin) {
      initialization.resolve();
      // 模拟入口先取得码，业务模块尚未执行，此时不调用会话 API。
      await vi.waitFor(() => expect(platform.sdk.login).toHaveBeenCalledOnce());
      expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/session"))).toBe(false);
    }
    if (early === "foreground-changed" || early === "login-stale") {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("pageshow"));
    }
  }
  const { createRuntime } = await import("./runtime");
  const official = vi.fn(async () => class {} as never);
  const runtime = createRuntime({ getConstructor: official });
  return { runtime, initialization, platform, adapter, resource, css, license, created, prefetch, security, official, fetcher, configResponse: () => response(config) };
}

it("投放授权就绪后在挂载前预取，只复用已确认的 VID 授权且不阻塞启动", async () => {
  const h = await preparationFixture("byteplus_web");
  const previousLocation = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState({}, "", "/?dramaId=201&episodeId=301");
  const entry = deferred();
  const originalFetch = h.fetcher.getMockImplementation()!;
  const drama = { id: "201", coverUrl: "" };
  const episode = { id: "301", dramaId: "201", posterUrl: "" };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  h.fetcher.mockImplementation(async (input, init) => {
    if (!String(input).endsWith("/play/entry")) return originalFetch(input, init);
    await entry.promise;
    return new Response(JSON.stringify({
      code: 0, serverTime: new Date().toISOString(), data: { entry: {
        target: { dramaId: drama.id, episodeId: episode.id }, drama, episode,
        entryAdStatus: { enabled: false, completedCount: 0, requiredCount: 0 },
        vipState: { active: true, adCount: 2, requiredCount: 2, progressDate: "2026-11-18", validUntil: expiresAt },
        play: { status: "playable", drama, episode, playback: { vid: "launch-vid", playAuthToken: "fixture-launch-token", expiresAt } },
      } },
    }));
  });
  const mediaInfo = deferred();
  h.prefetch.mockImplementationOnce(() => mediaInfo.promise.then(() => [{ status: "fulfilled" }]));
  try {
    h.initialization.resolve();
    const startup = h.runtime.bootstrap();
    await h.runtime.preparePlayback!();
    expect(h.prefetch).not.toHaveBeenCalled();
    entry.resolve();
    await startup;
    expect(h.prefetch).toHaveBeenCalledExactlyOnceWith([{
      vid: "launch-vid", getVideoByToken: { playAuthToken: "fixture-launch-token", needPoster: true },
    }]);
    expect(h.runtime.getLaunchTarget()).toMatchObject({ dramaId: "201", episodeId: "301" });
    expect(h.created).not.toHaveBeenCalled();
  } finally {
    entry.resolve();
    mediaInfo.resolve();
    window.history.replaceState({}, "", previousLocation);
  }
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 启动交接复用业务模块之前取得的登录码", async provider => {
  const h = await preparationFixture(provider, "login");
  const startup = h.runtime.bootstrap();
  await Promise.all([startup, h.runtime.preparePlayback!()]);
  expect(h.platform.sdk.login).toHaveBeenCalledOnce();
  expect(window.__TIKTOK_MINIS_INITIALIZE__).toHaveBeenCalledOnce();
  expect(h.fetcher.mock.calls.filter(([input]) => String(input).endsWith("/session"))).toHaveLength(1);
});

it("入口取得的登录码经过真实后台切换不能用于之后的会话", async () => {
  const h = await preparationFixture("tiktok_minis", "login-stale");
  await h.runtime.bootstrap();
  expect(h.platform.sdk.login).toHaveBeenCalledTimes(2);
  expect(h.fetcher.mock.calls.filter(([input]) => String(input).endsWith("/session"))).toHaveLength(1);
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 复用入口提前发出的配置请求，登录与准备不会各发一次", async provider => {
  const h = await preparationFixture(provider, "same-foreground");
  const config = h.runtime.prefetchAppConfig!();
  const boot = h.runtime.bootstrap();
  const preparation = h.runtime.preparePlayback!();
  h.initialization.resolve();
  await Promise.all([config, boot, preparation]);
  const configs = h.fetcher.mock.calls.filter(([input]) => String(input).includes("/open/app-config"));
  expect(configs).toHaveLength(1);
  expect(new Headers(configs[0][1]?.headers).has("authorization")).toBe(false);
  expect(h.platform.sdk.login).toHaveBeenCalledOnce();
  expect(h.runtime.getApplicationBrand().name).toBe("Test");
  const directHints = document.head.querySelectorAll('link[rel="preconnect"][href="https://vod.byteplusapi.com"]');
  expect(directHints).toHaveLength(provider === "byteplus_web" ? 1 : 0);
  expect(h.official).toHaveBeenCalledTimes(provider === "tiktok_minis" ? 1 : 0);
  expect(h.created).not.toHaveBeenCalled();
});

it("入口预取后经历真实前后台切换，Runtime 重新读取应用配置", async () => {
  const h = await preparationFixture("tiktok_minis", "foreground-changed");
  await h.runtime.prefetchAppConfig!();
  expect(h.fetcher.mock.calls.filter(([input]) => String(input).includes("/open/app-config"))).toHaveLength(2);
  expect(h.runtime.getApplicationBrand().name).toBe("Test");
  expect(h.official).not.toHaveBeenCalled();
  expect(h.platform.sdk.login).not.toHaveBeenCalled();
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 的适配器随 Runtime 模块就绪，配置安装不再等待额外模块且不提前加载 Full", async provider => {
  const h = await preparationFixture(provider);
  // 构造器定义已随业务入口就绪，不应在服务端配置返回后才下载一份适配器模块。
  expect(h.adapter).toHaveBeenCalledOnce();
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(h.resource).not.toHaveBeenCalled();
  expect(h.css).not.toHaveBeenCalled();
  expect(h.license).not.toHaveBeenCalled();
  expect(h.security.setPlayerVerificationConfig).not.toHaveBeenCalled();
  await h.runtime.prefetchAppConfig!();
  expect(h.runtime.getApplicationBrand().name).toBe("Test");
  expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ event: "player_configuration_ready", provider }));
  expect(h.adapter).toHaveBeenCalledOnce();
  expect(h.fetcher).toHaveBeenCalledOnce();
  expect(h.resource).not.toHaveBeenCalled();
  expect(h.css).not.toHaveBeenCalled();
  expect(h.license).not.toHaveBeenCalled();
  expect(h.created).not.toHaveBeenCalled();
  expect(h.official).not.toHaveBeenCalled();
  expect(h.platform.sdk.login).not.toHaveBeenCalled();
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 在 SDK 初始化期间只加载选中通道资源，许可、登录和创建仍等待各自条件", async provider => {
  const h = await preparationFixture(provider);
  const initialized = vi.fn();
  const prepared = vi.fn();
  let finishConfig!: (value: Response) => void;
  const config = new Promise<Response>(resolve => { finishConfig = resolve; });
  const originalFetch = h.fetcher.getMockImplementation()!;
  h.fetcher.mockImplementation((input, init) => String(input).includes("/open/app-config") ? config : originalFetch(input, init));
  const earlyConfig = h.runtime.prefetchAppConfig!();
  expect(h.fetcher.mock.calls.map(([input]) => String(input))).toEqual([expect.stringContaining("/open/app-config")]);
  const boot = h.runtime.bootstrap().then(initialized);
  const preparation = h.runtime.preparePlayback!().then(prepared);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(h.resource).not.toHaveBeenCalled();
    expect(h.css).not.toHaveBeenCalled();
    expect(h.official).not.toHaveBeenCalled();
    finishConfig(h.configResponse());
    await earlyConfig;
    if (provider === "byteplus_web") {
      await vi.waitFor(() => expect(h.resource).toHaveBeenCalledOnce());
      expect(h.css).toHaveBeenCalledOnce();
    } else {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.resource).not.toHaveBeenCalled();
      expect(h.css).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.platform.sdk.login).not.toHaveBeenCalled();
    expect(h.official).not.toHaveBeenCalled();
    expect(h.license).not.toHaveBeenCalled();
    expect(h.security.setPlayerVerificationConfig).not.toHaveBeenCalled();
    expect(prepared).not.toHaveBeenCalled();
    expect(initialized).not.toHaveBeenCalled();
    h.initialization.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await boot;
    expect(h.platform.sdk.login).toHaveBeenCalledOnce();
    if (provider === "byteplus_web") {
      expect(h.security.setPlayerVerificationConfig).toHaveBeenCalledOnce();
      expect(h.license).toHaveBeenCalledOnce();
      expect(h.official).not.toHaveBeenCalled();
    } else {
      expect(h.official).toHaveBeenCalledOnce();
      expect(h.resource).not.toHaveBeenCalled();
      expect(h.license).not.toHaveBeenCalled();
    }
    await preparation;
    expect(h.created).not.toHaveBeenCalled();
    expect(h.fetcher.mock.calls.some(([input]) => /play\/resolve|reward-grants|entry-ad|vip\/offer/.test(String(input)))).toBe(false);
    expect(h.platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
    expect(h.fetcher.mock.calls.filter(([input]) => String(input).includes("/open/app-config"))).toHaveLength(1);
  } finally {
    finishConfig(h.configResponse());
    h.initialization.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled([earlyConfig, boot, preparation]);
  }
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 的 SDK 初始化失败仍拒绝准备，不创建或切换播放器，失败诊断保留原因并脱敏", async provider => {
  const h = await preparationFixture(provider);
  const boot = h.runtime.bootstrap();
  const preparation = h.runtime.preparePlayback!();
  const rejected = [expect(boot).rejects.toThrow("TikTok initialization failed"), expect(preparation).rejects.toThrow("TikTok initialization failed")];
  if (provider === "byteplus_web") await vi.waitFor(() => expect(h.resource).toHaveBeenCalledOnce());
  else await vi.advanceTimersByTimeAsync(0);
  h.initialization.reject(new Error("TikTok initialization failed https://private.example/?token=secret token=credential"));
  await Promise.all(rejected);
  expect(h.official).not.toHaveBeenCalled();
  expect(h.license).not.toHaveBeenCalled();
  expect(h.created).not.toHaveBeenCalled();
  expect(h.platform.sdk.login).not.toHaveBeenCalled();
  expect(h.platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ event: "tiktok_sdk_initialize_failed", error: "TikTok initialization failed [URL] token=[REDACTED]" }));
  if (provider === "byteplus_web") expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ event: "direct_player_initialization_failed", error: "TikTok initialization failed [URL] token=[REDACTED]" }));
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/secret|credential|https:\/\//);
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 配置迟于 SDK 失败时不自动重新初始化，保留失败结果且不继续加载播放器", async provider => {
  const h = await preparationFixture(provider);
  let finishConfig!: (value: Response) => void;
  const config = new Promise<Response>(resolve => { finishConfig = resolve; });
  const originalFetch = h.fetcher.getMockImplementation()!;
  h.fetcher.mockImplementation((input, init) => String(input).includes("/open/app-config") ? config : originalFetch(input, init));
  const boot = h.runtime.bootstrap();
  const preparation = h.runtime.preparePlayback!();
  const rejected = [expect(boot).rejects.toThrow("Initialization failed before configuration"), expect(preparation).rejects.toThrow("Initialization failed before configuration")];
  h.initialization.reject(new Error("Initialization failed before configuration"));
  await Promise.all(rejected);
  finishConfig(h.configResponse());
  await vi.advanceTimersByTimeAsync(3_000);
  expect(window.__TIKTOK_MINIS_INITIALIZE__).toHaveBeenCalledOnce();
  expect(h.resource).not.toHaveBeenCalled();
  expect(h.css).not.toHaveBeenCalled();
  expect(h.official).not.toHaveBeenCalled();
  expect(h.license).not.toHaveBeenCalled();
  expect(h.created).not.toHaveBeenCalled();
});

it("官方通道身份安装失败时不准备构造器，重试仍须经过新的完整身份安装", async () => {
  const h = await preparationFixture("tiktok_minis");
  let denyIdentity = true;
  const originalFetch = h.fetcher.getMockImplementation()!;
  h.fetcher.mockImplementation((input, init) => String(input).endsWith("/session") && denyIdentity
    ? Promise.resolve(new Response(JSON.stringify({ code: 503, reason: "service_unavailable" }), { status: 503 }))
    : originalFetch(input, init));
  const boot = h.runtime.bootstrap();
  const preparation = h.runtime.preparePlayback!();
  const rejected = [expect(boot).rejects.toThrow(), expect(preparation).rejects.toThrow()];
  h.initialization.resolve();
  await Promise.all(rejected);
  expect(h.official).not.toHaveBeenCalled();
  expect(h.runtime.getSessionSubjectKey!()).toBe("");
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ event: "bootstrap_failed", error: expect.any(String) }));
  denyIdentity = false;
  await Promise.all([h.runtime.bootstrap(), h.runtime.preparePlayback!()]);
  expect(h.official).toHaveBeenCalledOnce();
  expect(h.resource).not.toHaveBeenCalled();
  expect(h.platform.sdk.login).toHaveBeenCalledTimes(2);
});

it.each([0, 1, 2])("独立资源准备与 SDK 失败交错时不隐式重试：错误传播间隔=%s", async ticks => {
  const h = await preparationFixture("byteplus_web");
  const boot = h.runtime.bootstrap();
  const bootRejected = expect(boot).rejects.toThrow("Initialization failed during preparation");
  await vi.waitFor(() => expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ event: "player_configuration_ready" })));
  h.initialization.reject(new Error("Initialization failed during preparation"));
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
  const preparation = h.runtime.preparePlayback!();
  await Promise.all([bootRejected, expect(preparation).rejects.toThrow("Initialization failed during preparation")]);
  await vi.advanceTimersByTimeAsync(0);
  expect(window.__TIKTOK_MINIS_INITIALIZE__).toHaveBeenCalledOnce();
  expect(h.license).not.toHaveBeenCalled();
  expect(h.created).not.toHaveBeenCalled();
  expect(h.official).not.toHaveBeenCalled();
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 初始化失败后显式重试可恢复，仍等待新 SDK 及页面校验", async provider => {
  const h = await preparationFixture(provider);
  const rejected = [expect(h.runtime.bootstrap()).rejects.toThrow("First initialization failed"),
    expect(h.runtime.preparePlayback!()).rejects.toThrow("First initialization failed")];
  if (provider === "byteplus_web") await vi.waitFor(() => expect(h.resource).toHaveBeenCalledOnce());
  h.initialization.reject(new Error("First initialization failed"));
  await Promise.all(rejected);
  await vi.advanceTimersByTimeAsync(0);
  const retry = deferred();
  window.__TIKTOK_MINIS_INITIALIZE__ = vi.fn(async () => {
    await retry.promise;
    window.__TIKTOK_MINIS_INITIALIZED__ = true;
  });
  const boot = h.runtime.bootstrap();
  const preparation = h.runtime.preparePlayback!();
  await vi.advanceTimersByTimeAsync(0);
  expect(window.__TIKTOK_MINIS_INITIALIZE__).toHaveBeenCalledOnce();
  expect(h.official).not.toHaveBeenCalled();
  expect(h.license).not.toHaveBeenCalled();
  retry.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all([boot, preparation]);
  expect(provider === "byteplus_web" ? h.license : h.official).toHaveBeenCalledOnce();
  expect(h.created).not.toHaveBeenCalled();
  expect(h.platform.sdk.login).toHaveBeenCalledOnce();
  expect(h.platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
});
