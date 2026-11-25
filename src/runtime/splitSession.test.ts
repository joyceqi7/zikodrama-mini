import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpMiniDramaApi } from "../api/httpMiniDramaApi";
import type { AppConfig, SessionResult, VIPState } from "../domain/types";
import { createTikTokFixture } from "../test/tiktokFixture";
import { currentApplicationProfile } from "../config/applicationProfile";
import { getCampaignPreparation } from "./campaignPreparation";
import { prepareInitialAppConfig } from "./initialAppConfig";
import { createRuntime } from "./runtime";

const session: SessionResult = { applicationId: "1", tiktokAppId: "test-app", visitorId: "11", visitorToken: "test-session-token", identityState: "tiktok_authenticated", tiktokOpenId: "test-open-id" };
const config: AppConfig = { applicationId: "1", tiktokAppId: "test-app", appName: "Test", logoUrl: "", complianceBaseUrl: "", playbackSdk: { provider: "tiktok_minis", channel: "byteplus" }, monetization: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1, episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 }, vip: { enabled: true, requiredAdCount: 2, title: "", content: "" } } };
const state: VIPState = { active: false, adCount: 0, requiredCount: 2, progressDate: "2026-10-24" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: status === 200 ? 0 : status, reason: status === 401 ? "unauthorized" : "service_unavailable", serverTime: "2026-10-24T10:00:00Z", data }), { status });

function pendingResponse() {
  let release!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { release = resolve; });
  return { response, release };
}

let platform: ReturnType<typeof createTikTokFixture>;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) });
  platform = createTikTokFixture(); window.TTMinis = platform.sdk;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); delete window.TTMinis; window.history.replaceState({}, "", "/"); });

it.each(["ready", "missing", "pending"] as const)("投放并行准备目标，准备接口状态为 %s 时按原流程验权", async preparation => {
  const code = `prepare-${preparation}`;
  window.history.replaceState({}, "", `/?campaign_code=${code}`);
  const sessionPending = pendingResponse();
  const preparationPending = pendingResponse();
  const campaign = { id: "9", code, dramaId: "36", episodeId: "384" };
  const fetcher = vi.fn<typeof fetch>(async url => {
    const { pathname } = new URL(String(url), window.location.href);
    if (pathname.endsWith("/open/app-config")) return json(config);
    if (pathname.endsWith("/open/play/prepare")) return preparationPending.response;
    if (pathname.endsWith("/session")) return sessionPending.response;
    if (pathname.endsWith("/play/entry")) return json({ entry: null });
    if (pathname.endsWith("/me/vip")) return json(state);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  prepareInitialAppConfig(currentApplicationProfile(), window.location.search);
  const runtime = createRuntime();
  const startup = runtime.bootstrap();
  await vi.advanceTimersByTimeAsync(0);
  const early = fetcher.mock.calls.find(([url]) => String(url).includes("/open/play/prepare"))!;
  expect(String(early[0])).toContain(`campaignCode=${code}`);
  expect(new Headers(early[1]?.headers).has("authorization")).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/session"))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/play/entry"))).toBe(false);

  const preparationResult = json({
    target: { dramaId: "36", episodeId: "384" }, title: "Published drama",
    coverUrl: "https://img.tkdrama.site/covers/36.jpg", episodeNumber: 1, episodeCount: 10,
  });
  if (preparation === "ready") preparationPending.release(preparationResult);
  if (preparation === "missing") preparationPending.release(new Response("404 page not found", { status: 404 }));
  await vi.advanceTimersByTimeAsync(0);
  if (preparation === "ready") {
    expect(getCampaignPreparation()).toMatchObject({
      search: window.location.search, cover: { dramaId: "36", episodeId: "384", episodeCount: "10" },
    });
  }
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/play/entry"))).toBe(false);
  sessionPending.release(json({ ...session, campaign }));
  await startup;
  const authorization = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"));
  expect(authorization).toHaveLength(1);
  expect(new Headers(authorization[0][1]?.headers).get("authorization")).toBe("Bearer test-session-token");
  if (preparation === "pending") {
    window.history.replaceState({}, "", "/#/profile");
    preparationPending.release(preparationResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(getCampaignPreparation()?.search).not.toContain(code);
  }
});

it("新 Mini 启动及刷新不调用聚合接口，个人状态故障不撤销身份，恢复不重新登录", async () => {
  let unavailable = true;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return unavailable ? json(null, 503) : json(state);
    if (path.endsWith("/metrics")) return json({ accepted: true });
    throw new Error(`unexpected route ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime(); await runtime.bootstrap();
  expect(runtime.getVisitorID()).toBe("11");
  expect(runtime.getAdExperience().refreshRequired).toBe(true);
  unavailable = false; await runtime.refreshAdExperience();
  expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: false, vipState: state });
  expect(platform.sdk.login).toHaveBeenCalledOnce();
  const paths = fetcher.mock.calls.map(([url]) => String(url));
  expect(paths.filter(path => path.endsWith("/session"))).toHaveLength(1);
  expect(paths.some(path => /bootstrap|ad-experience|vip\/offer|launch\/resolve/.test(path))).toBe(false);
  const publicRequest = fetcher.mock.calls.find(([url]) => String(url).includes("/open/app-config"))!;
  expect(new Headers(publicRequest[1]?.headers).has("authorization")).toBe(false);
});

it("VIP 广告入口只在观看时请求，入口故障不使个人状态或登录失效", async () => {
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/me/vip/offer")) return json(null, 503);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime(); await runtime.bootstrap();
  await runtime.refreshAdExperience();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/offer"))).toBe(false);
  await expect(runtime.watchVIPAd()).rejects.toMatchObject({ status: 503 });
  expect(runtime.getAdExperience().refreshRequired).toBe(false);
  expect(runtime.getVisitorID()).toBe("11");
  expect(platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
  await runtime.refreshAdExperience(); expect(platform.sdk.login).toHaveBeenCalledOnce();
});

it("配置失败后的重试保留已建立会话，个人配置不进入登录屏障", async () => {
  let release!: (response: Response) => void;
  let configRequests = 0;
  const first = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return ++configRequests === 1 ? first : json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime(); const boot = runtime.bootstrap();
  await vi.waitFor(() => expect(runtime.getVisitorID()).toBe("11"));
  release(json(null, 503)); await expect(boot).rejects.toMatchObject({ status: 503 });
  await runtime.bootstrap();
  await runtime.refreshAdExperience();
  expect(platform.sdk.login).toHaveBeenCalledOnce();
  expect(runtime.getAdExperience().vipState).toMatchObject(state);
});

it("同一前台启动的首页预取、登录和权益查询只读取一次应用配置", async () => {
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/open/catalog")) return json({ tiktokAppId: "test-app", dramas: [] });
    if (path.includes("/open/home/")) return json([]);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const runtime = createRuntime();
  await Promise.all([runtime.prefetchHome!(), runtime.bootstrap()]);
  await runtime.refreshAdExperience();
  await Promise.all([runtime.loadHomeSections!(), runtime.loadPublicCatalog!()]);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/open/app-config"))).toHaveLength(1);
  expect(platform.sdk.login).toHaveBeenCalledOnce();
  expect(logging).not.toHaveBeenCalled();
});

it("显式恢复重新确认一次配置，并按新审核修订隔离首页缓存", async () => {
  let revision = 1;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json({ ...config, appName: `应用 ${revision}`, miniReview: { enabled: false, episodeOnly: false, revision } });
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/open/catalog")) return json({ tiktokAppId: "test-app", dramas: [], tags: [`修订 ${revision}`] });
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  await runtime.bootstrap();
  await runtime.loadPublicCatalog!();
  expect(runtime.getCachedPublicCatalog!()?.tags).toEqual(["修订 1"]);
  revision = 2;
  await runtime.refreshBootstrap();
  expect(runtime.getApplicationBrand().name).toBe("应用 2");
  expect(runtime.getCachedPublicCatalog!()).toBeUndefined();
  await runtime.loadPublicCatalog!();
  expect(runtime.getCachedPublicCatalog!()?.tags).toEqual(["修订 2"]);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/open/app-config"))).toHaveLength(2);
});

it("回到前台的权益与公开首页刷新共用一次新配置确认", async () => {
  let revision = 1;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json({ ...config, appName: `应用 ${revision}`, miniReview: { enabled: false, episodeOnly: false, revision } });
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.includes("/open/home/")) return json([]);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  await runtime.bootstrap();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  revision = 2;
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.all([runtime.refreshAdExperience(), runtime.loadHomeSections!()]);
  expect(runtime.getApplicationBrand().name).toBe("应用 2");
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/open/app-config"))).toHaveLength(2);
});

it.each([true, false])("跨越前后台的在途配置不能确认新前台，恢复早于响应=%s", async resumeBeforeResponse => {
  let finish!: (response: Response) => void;
  const first = new Promise<Response>(resolve => { finish = resolve; });
  let configurations = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return ++configurations === 1 ? first : json({ ...config, appName: "新前台配置" });
    if (path.endsWith("/open/catalog")) return json({ tiktokAppId: "test-app", dramas: [] });
    if (path.includes("/open/home/")) return json([]);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const runtime = createRuntime();
  const catalog = runtime.loadPublicCatalog!();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  if (!resumeBeforeResponse) {
    finish(json({ ...config, appName: "旧前台配置" }));
    await catalog;
    expect(configurations).toBe(1);
  }
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  const sections = runtime.loadHomeSections!();
  finish(json({ ...config, appName: "旧前台配置" }));
  await Promise.all([catalog, sections]);
  expect(configurations).toBe(2);
  expect(runtime.getApplicationBrand().name).toBe("新前台配置");
  expect(logging).not.toHaveBeenCalled();
});

it("首次宿主前台确认不会使刚加载的配置失效，真正隐藏再显示才刷新", async () => {
  const listeners = new Map<string, () => void>();
  platform.sdk.on = vi.fn((event, listener) => { listeners.set(event, listener); return event; });
  platform.sdk.off = vi.fn(() => true);
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  await runtime.bootstrap();
  listeners.get("minis.show")!();
  await runtime.refreshAdExperience();
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/open/app-config"))).toHaveLength(1);
  listeners.get("minis.hide")!();
  listeners.get("minis.show")!();
  await runtime.refreshAdExperience();
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/open/app-config"))).toHaveLength(2);
});

it("配置刷新失败有诊断，再次读取不能复用旧确认且成功后恢复合并", async () => {
  let configurations = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return ++configurations === 2 ? json(null, 503) : json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/open/catalog")) return json({ tiktokAppId: "test-app", dramas: [] });
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const runtime = createRuntime();
  await runtime.bootstrap();
  await expect(runtime.refreshBootstrap()).rejects.toMatchObject({ status: 503 });
  expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "app_configuration_failed", error: expect.any(String) }));
  logging.mockClear();
  await runtime.loadPublicCatalog!();
  await runtime.refreshAdExperience();
  expect(configurations).toBe(3);
  expect(logging).not.toHaveBeenCalled();
});

it.each((["tiktok_minis", "byteplus_web"] as const).flatMap(provider =>
  ["config", "entry"].map(first => ({ provider, first })),
))("$provider 投放会话就绪立即请求入剧，$first 先回包仍按确认通道交付", async ({ provider, first }) => {
  window.history.replaceState({}, "", "/?campaignCode=campaign-1");
  const poster = "https://images.example/confirmed-episode.jpg";
  const episode = { id: "episode-2", dramaId: "drama", number: 2, title: "Episode 2", posterUrl: poster, description: "", durationSeconds: 60, accessMode: "free" };
  const summary = { id: "drama", firstEpisodeId: "episode-1", title: "Test Drama", description: "", coverUrl: "https://images.example/summary.jpg", episodeCount: 2, tags: [], status: "ongoing" };
  const playback = { channel: "byteplus", vid: "fixture-vid", posterUrl: poster, title: "Episode 2", episodeNumber: 2, durationSeconds: 60,
    ...(provider === "byteplus_web" ? { playAuthToken: "fixture-private-token", expiresAt: "2026-10-24T10:05:00Z" }
      : { albumId: "platform-album", episodeId: "platform-episode" }) };
  const application = { ...config, playbackSdk: { provider, channel: "byteplus", ...(provider === "byteplus_web" ? { capabilities: { mediaPreload: false } } : {}) } };
  const visitor = { ...session, campaign: { id: "campaign-1", code: "campaign-1", dramaId: "drama", episodeId: "episode-2" } };
  const vipState = { ...state, adCount: 1 };
  const entryAdStatus = { enabled: false, completedCount: 0, requiredCount: 0 };
  const entry = { target: { dramaId: "drama", episodeId: "episode-2" }, drama: summary, episode, entryAdStatus, vipState,
    play: { status: "playable", drama: summary, episode, playback } };
  const appConfig = pendingResponse();
  const visitorSession = pendingResponse();
  const playbackEntry = pendingResponse();
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return appConfig.response;
    if (path.endsWith("/session")) return visitorSession.response;
    if (path.endsWith("/play/entry")) return playbackEntry.response;
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/metrics")) return json({ accepted: true });
    throw new Error(`unexpected route ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  const boot = runtime.bootstrap();
  const completed = boot.then(() => ({ ok: true }), error => ({ ok: false, error }));
  const requests = (path: string) => fetcher.mock.calls.filter(([url]) => String(url).split("?")[0].endsWith(path));
  await vi.waitFor(() => {
    expect(requests("/open/app-config")).toHaveLength(1);
    expect(requests("/session")).toHaveLength(1);
  });
  expect(requests("/play/entry")).toHaveLength(0);
  visitorSession.release(json(visitor));
  await vi.waitFor(() => expect(requests("/play/entry")).toHaveLength(1));
  const [, entryRequest] = requests("/play/entry")[0];
  expect(new Headers(entryRequest?.headers).get("authorization")).toBe("Bearer test-session-token");
  expect(JSON.parse(String(entryRequest?.body))).toEqual({ source: "launch", launchQuery: { campaignCode: "campaign-1" } });

  if (first === "config") appConfig.release(json(application));
  else playbackEntry.release(json({ entry }));
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.getLaunchTarget()).toBeUndefined();
  expect(runtime.getCachedPlaybackCover!("drama", "episode-2")).toBe("");
  expect(runtime.getAdExperience().vipState.adCount).toBe(0);
  if (first === "config") playbackEntry.release(json({ entry }));
  else appConfig.release(json(application));
  expect(await completed).toEqual({ ok: true });
  const calls = fetcher.mock.calls.length;
  expect(runtime.getLaunchTarget()).toEqual(entry.target);
  expect(runtime.getAdExperience().vipState).toMatchObject(vipState);
  expect(await runtime.resolvePlaybackEntry!("drama", "episode-2")).toMatchObject({
    entryAdStatus, vipState, play: { status: "playable", playback: { provider } },
  });
  expect(runtime.getCachedPlaybackCover!("drama", "episode-2")).toBe(poster);
  expect(runtime.getCachedPlaybackCover!("other-drama", "episode-2")).toBe("");
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("");
  expect(runtime.getCachedPlaybackCover!("drama", "")).toBe("");
  expect(await runtime.loadPlaybackCover!("drama", "episode-2")).toBe(poster);
  expect(await runtime.resolvePlayback!("drama", "episode-2")).toMatchObject({ status: "playable", playback: { provider, vid: "fixture-vid" } });
  expect(fetcher.mock.calls).toHaveLength(calls);
  expect(requests("/play/entry")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_001);
  const afterTimers = fetcher.mock.calls.length;
  expect(runtime.getCachedPlaybackCover!("drama", "episode-2")).toBe("");
  expect(fetcher.mock.calls).toHaveLength(afterTimers);
  expect(fetcher.mock.calls.some(([url]) => /open\/catalog|\/dramas\/|play\/resolve/.test(String(url)))).toBe(false);
});

it("配置失败后迟到的会话不会触发已失败轮次的投放请求，重试复用该会话", async () => {
  window.history.replaceState({}, "", "/?campaignCode=campaign-1");
  const visitorSession = pendingResponse();
  const appConfig = pendingResponse();
  let configRequests = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return ++configRequests === 1 ? appConfig.response : json(config);
    if (path.endsWith("/session")) return visitorSession.response;
    if (path.endsWith("/play/entry")) return json({ entry: null });
    if (path.endsWith("/me/vip")) return json(state);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  const failed = expect(runtime.bootstrap()).rejects.toMatchObject({ status: 503 });
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/session"))).toBe(true));
  appConfig.release(json(null, 503));
  await failed;
  visitorSession.release(json({ ...session, campaign: { id: "campaign-1", code: "campaign-1", dramaId: "drama", episodeId: "episode-2" } }));
  await vi.waitFor(() => expect(runtime.getVisitorID()).toBe(session.visitorId));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"))).toHaveLength(0);

  await runtime.bootstrap();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"))).toHaveLength(1);
  expect(platform.sdk.login).toHaveBeenCalledOnce();
});

it("目标海报和剧场合并同身份的在途详情，缓存首图不替代播放验权或永久缓存详情", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const detail = { id: "drama", coverUrl: "https://images.example/drama.jpg", episodes: [
    { id: "episode-1", dramaId: "drama", posterUrl: "https://images.example/first.jpg" },
    { id: "episode-2", dramaId: "drama", posterUrl: "" },
  ] };
  let details = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/dramas/drama")) return ++details === 1 ? pending : json(detail);
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  await runtime.bootstrap();
  const first = runtime.loadPlaybackCover!("drama", "episode-1");
  const repeated = runtime.loadPlaybackCover!("drama", "episode-1");
  const secondEpisode = runtime.loadPlaybackCover!("drama", "episode-2");
  const theater = runtime.api.drama("drama");
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("");
  await vi.waitFor(() => expect(details).toBe(1));
  finish(json(detail));
  expect(await Promise.all([first, repeated, secondEpisode, theater])).toEqual([
    "https://images.example/first.jpg", "https://images.example/first.jpg", "https://images.example/drama.jpg", detail,
  ]);
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("https://images.example/first.jpg");
  expect(runtime.getCachedPlaybackCover!("drama", "episode-2")).toBe("https://images.example/drama.jpg");
  await runtime.loadPlaybackCover!("drama", "episode-1");
  expect(details).toBe(1);
  await runtime.api.drama("drama");
  expect(details).toBe(2);
  await vi.advanceTimersByTimeAsync(20_001);
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("");
  await runtime.loadPlaybackCover!("drama", "episode-1");
  expect(details).toBe(3);
  await runtime.refreshBootstrap();
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("");
  expect(details).toBe(3);
  expect(fetcher.mock.calls.some(([url]) => /open\/catalog|play\/resolve/.test(String(url)))).toBe(false);
});

it("目标海报失败记录脱敏原因并释放失败请求，成功重试不误报故障", async () => {
  let details = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/dramas/drama")) {
      if (++details === 1) throw new Error("Poster lookup failed token=private-value");
      return json({ id: "drama", coverUrl: "https://images.example/drama.jpg", episodes: [] });
    }
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const logging = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const runtime = createRuntime();
  await runtime.bootstrap();
  await expect(runtime.loadPlaybackCover!("drama", "episode-1")).rejects.toMatchObject({ code: "network_error" });
  expect(logging).toHaveBeenCalledWith({ event: "playback_launch_cover_load_failed", error: "Poster lookup failed token=[REDACTED]" });
  expect(JSON.stringify([...logging.mock.calls, ...errors.mock.calls])).not.toContain("private-value");
  logging.mockClear(); errors.mockClear();
  await expect(runtime.loadPlaybackCover!("drama", "episode-1")).resolves.toBe("https://images.example/drama.jpg");
  expect(details).toBe(2);
  expect(logging).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

it.each([false, true])("换主体后回到原主体=%s 时不复用旧代次海报或在途详情", async returnToOriginal => {
  let viewer = "viewer-A";
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  let details = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json({ ...session, visitorId: viewer });
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/dramas/drama")) return ++details === 1 ? pending : json({ id: "drama", coverUrl: "https://images.example/current.jpg", episodes: [] });
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  await runtime.bootstrap();
  const oldCover = expect(runtime.loadPlaybackCover!("drama", "episode-1")).rejects.toMatchObject({ code: "identity_changed" });
  await vi.waitFor(() => expect(details).toBe(1));
  viewer = "viewer-B";
  await runtime.refreshBootstrap();
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("");
  await expect(runtime.loadPlaybackCover!("drama", "episode-1")).resolves.toBe("https://images.example/current.jpg");
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("https://images.example/current.jpg");
  if (returnToOriginal) {
    viewer = "viewer-A";
    await runtime.refreshBootstrap();
    expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("");
    await expect(runtime.loadPlaybackCover!("drama", "episode-1")).resolves.toBe("https://images.example/current.jpg");
  }
  finish(json({ id: "drama", coverUrl: "https://images.example/previous.jpg", episodes: [] }));
  await oldCover;
  expect(runtime.getCachedPlaybackCover!("drama", "episode-1")).toBe("https://images.example/current.jpg");
  await expect(runtime.loadPlaybackCover!("drama", "episode-1")).resolves.toBe("https://images.example/current.jpg");
  expect(details).toBe(returnToOriginal ? 3 : 2);
});

it("并发 401 仅恢复一次独立会话，不读取配置、权益或旧 bootstrap", async () => {
  let sessions = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/session")) return json({ ...session, visitorToken: `token-${++sessions}` });
    if (new Headers(init?.headers).get("authorization") === "Bearer token-1") return json(null, 401);
    return json(state);
  });
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  const input = { tiktokAppId: "test-app", loginCode: "login", launchQuery: {} };
  api.setSessionInputProvider(async () => input, () => {});
  await api.createSession(input);
  await Promise.all([api.vipState(), api.vipState()]);
  expect(sessions).toBe(2);
  expect(fetcher.mock.calls.every(([url]) => /\/(session|me\/vip)$/.test(String(url)))).toBe(true);
});

it("入剧展示确认直接返回服务端进度，不调用旧展示接口或追加进度查询", async () => {
  const entryAdStatus = { enabled: true, countBy: "shown", scope: "user_drama", shownCount: 2, completedCount: 0, requiredCount: 2, progressDate: "2026-10-24", validUntil: "2026-10-25T00:00:00Z", offer: { kind: "rewarded_entry", adUnitId: "ad", offerId: "offer" } };
  const fetcher = vi.fn<typeof fetch>(async () => json({ accepted: true, entryAdStatus }));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  expect(await api.recordAdShow({ scene: "entry_reward", eventId: "show", adUnitId: "ad", dramaId: "201" })).toMatchObject({ accepted: true, entryAdStatus });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe("https://api.example.test/api/v1/me/entry-ad/shows");
});

it.each(["hidden", "claimed"])("VIP Offer 查询期间 %s，迟到入口不再拉起广告", async (change) => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(config);
    if (path.endsWith("/session")) return json(session);
    if (path.endsWith("/me/vip")) return json(state);
    if (path.endsWith("/me/vip/offer")) return pending;
    if (path.endsWith("/vip/claim")) return json({ ...state, active: true, adCount: 2 });
    return json({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime(); await runtime.bootstrap();
  await runtime.refreshAdExperience();
  const watching = runtime.watchVIPAd();
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/offer"))).toBe(true));
  if (change === "hidden") vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  else await runtime.claimVIP();
  release(json({ offer: { kind: "rewarded_vip", offerId: "offer", adUnitId: "ad" } }));
  if (change === "hidden") await expect(watching).rejects.toMatchObject({ code: "ad_foreground_required" });
  else await expect(watching).resolves.toBeNull();
  expect(platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
});
