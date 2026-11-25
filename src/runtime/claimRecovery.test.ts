import { splitConsumerFetch } from "../test/splitConsumerFetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/httpMiniDramaApi";
import type { BootstrapResult, RewardClaim } from "../domain/types";
import { PendingClaimStore } from "../domain/pendingClaims";
import { createRuntime, isRetryableClaimError, type EntitlementChange } from "./runtime";
import type { TikTokMinisSDK, TikTokVePlayerConstructor } from "../platform/tiktok/types";
import { createTikTokFixture } from "../test/tiktokFixture";
import { adPolicy } from "../config/adPolicy";

// 场景使用真实 runtime 与 HttpMiniDramaApi，网络仅由测试 fetch 提供，不写真实平台。
const claim: RewardClaim = { claimId: "claim-a-0001", offerId: "offer", adUnitId: "ad" };
const settlement = { claimId: claim.claimId, status: "granted", rewardType: "vip_progress", unlocked: false,
  vipState: { active: true, adCount: 1, requiredCount: 1, progressDate: "today" } };
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify({ serverTime: new Date().toISOString(), ...(data as object) }), { status });
const identity = (visitorId = "A"): BootstrapResult => ({
  applicationId: "application", tiktokAppId: "test-app", visitorId, visitorToken: `token-${visitorId}`,
  appName: "Test Drama", logoUrl: "", complianceBaseUrl: "", identityState: "tiktok_authenticated",
  playbackSdk: { provider: "tiktok_minis", channel: "byteplus" },
  vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "today" },
  monetization: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 0,
    episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
    vip: { enabled: true, requiredAdCount: 1, title: "", content: "" } },
});
const store = (visitorId: string) => new PendingClaimStore(localStorage, `test-app:application:${visitorId}`);
let platform: ReturnType<typeof createTikTokFixture>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

/** pendingNativeAd 控制无终止回调和迟到回调，不通过假取消释放原生请求。 */
function pendingNativeAd() {
  let close!: (value: { isEnded: boolean }) => void;
  let error!: (reason: unknown) => void;
  const shown = deferred<void>();
  const create = vi.spyOn(platform.sdk, "createRewardedVideoAd").mockImplementation(() => ({
    show: () => shown.promise,
    onClose: fn => { close = fn; }, onError: fn => { error = fn; }, offClose: vi.fn(), offError: vi.fn(),
  }));
  return { create, shown, close: () => close({ isEnded: true }), error: () => error(new Error("late native error")) };
}

beforeEach(() => {
  const entries = new Map<string, string>();
  // Node 的实验性 localStorage 不等同于 WebView Storage，测试显式使用隔离实现。
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(), key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  } satisfies Storage);
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  platform = createTikTokFixture();
  window.TTMinis = platform.sdk;
  vi.useFakeTimers();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); delete window.TTMinis; });

describe("仅客户端保存的观众书架", () => {
  it("收藏/进度/历史按应用和 Visitor 隔离，切号不泄露且旧页面仍写原分区", async () => {
    let currentVisitor = "A";
    const fetcher = vi.fn<typeof fetch>(async () => json({ data: identity(currentVisitor) }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    fetcher.mockClear();
    const originalLibrary = runtime.localLibrary;
    originalLibrary.setFollow("drama-1", true);
    originalLibrary.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 24, durationSeconds: 60 });
    expect(originalLibrary.follows()).toHaveLength(1);
    expect(originalLibrary.history()[0].progressSeconds).toBe(24);
    expect(fetcher).not.toHaveBeenCalled();

    const reloaded = createRuntime();
    await reloaded.bootstrap();
    expect(reloaded.localLibrary.isFollowing("drama-1")).toBe(true);
    expect(reloaded.localLibrary.history()[0].progressSeconds).toBe(24);
    currentVisitor = "B";
    await runtime.refreshBootstrap();
    fetcher.mockClear();
    expect(runtime.localLibrary.follows()).toEqual([]);
    expect(runtime.localLibrary.history()).toEqual([]);
    originalLibrary.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 28, durationSeconds: 60 });
    expect(runtime.localLibrary.history()).toEqual([]);
    expect(reloaded.localLibrary.history()[0].progressSeconds).toBe(28);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("Storage getter 被禁用时仍可创建运行时和读取空的匿名本地库", () => {
    const read = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Storage blocked", "SecurityError"); });
    try { expect(createRuntime().localLibrary.history()).toEqual([]); }
    finally { read.mockRestore(); }
  });

  it("启动不等待旧奖励补领，但同一主体仍在后台使用原 ClaimID 结算", async () => {
    const pending = deferred<Response>();
    store("A").add(claim);
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("session") ? json({ data: identity() }) : pending.promise);
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    let ready = false;
    void runtime.bootstrap().then(() => { ready = true; });
    await vi.waitFor(() => expect(ready).toBe(true));
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("reward-grants"))).toBe(true));
    expect(store("A").list()).toEqual([claim]);
    pending.resolve(json({ data: settlement }));
    await vi.waitFor(() => expect(store("A").list()).toEqual([]));
  });
});

describe("SDK启动分类、会话恢复与权益通知", () => {
  it("已确认的当前主体 VIPState 直接采用服务端状态，不按客户端套餐推断或改写", async () => {
    const confirmed = { active: false, adCount: 4, requiredCount: 7, progressDate: "server-business-date" };
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => String(url).endsWith("session")
      ? json({ data: identity() }) : json({ data: { ...settlement, vipState: confirmed } })), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.claimReward(claim);
    expect(runtime.getAdExperience().vipState).toEqual(confirmed);
    expect(runtime.getAdExperience().monetizationPolicy.vip.requiredAdCount).toBe(1);
  });

  it.each(["throw", "unsupported"])("SDK %s 不发送缺码bootstrap，也不收集installationId", async (mode) => {
    window.TTMinis = {
      canIUse: () => mode !== "unsupported",
      login: (options: { fail(result: unknown): void }) => {
        if (mode === "fail") options.fail({ error: { error_msg: "private platform details" } });
        if (mode === "throw") throw new Error("bridge failure");
      },
    } as unknown as TikTokMinisSDK;
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const expectedCode = mode === "timeout" ? "request_timeout" : mode === "unsupported" ? "identity_unsupported" : "identity_unavailable";
    const pending = expect(createRuntime().bootstrap()).rejects.toMatchObject({ code: expectedCode });
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(3001);
    await pending;
    expect(fetcher).not.toHaveBeenCalled();
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some((key) => key?.startsWith("drama:installation:"))).toBe(false);
  });

  it("观察者封闭身份后发布可恢复状态，用户并发重试只重新启动一次", async () => {
    let boots = 0;
    const recovered = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (!String(url).endsWith("session")) return json({ data: { dramas: [] } });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("installationId");
      boots += 1;
      if (boots === 2) return json({ data: { ...identity("B"), applicationId: "wrong-application" } });
      if (boots === 3) return recovered.promise;
      return json({ data: identity() });
    });
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    const states: string[] = [];
    const visibleSubjects: string[] = [];
    runtime.subscribeAdExperience(() => visibleSubjects.push(runtime.getSessionSubjectKey!()));
    runtime.subscribeSessionState!(() => states.push(runtime.getSessionState!()));
    await runtime.bootstrap();
    const originalSubject = runtime.getSessionSubjectKey!();
    await expect(runtime.refreshBootstrap()).rejects.toThrow();
    expect(runtime.getSessionSubjectKey!()).toBe(originalSubject);
    expect(visibleSubjects.filter(Boolean).every(subject => subject === originalSubject)).toBe(true);
    expect(runtime.getSessionState!()).toBe("recovery_required");
    await expect(runtime.api.home()).rejects.toMatchObject({ code: "identity_unavailable" });
    const first = runtime.recoverSession!();
    const second = runtime.recoverSession!();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(boots).toBe(3));
    recovered.resolve(json({ data: identity() }));
    await Promise.all([first, second]);
    expect(states).toEqual(["recovery_required", "ready"]);
    expect(runtime.getVisitorID()).toBe("A");
    await expect(runtime.api.home()).resolves.toEqual({ dramas: [] });
    expect(visibleSubjects.at(-1)).toBe(originalSubject);
    expect(visibleSubjects.filter(Boolean).every(subject => subject === originalSubject)).toBe(true);
  });

  it("后台补领的剧集确认结果发布当前主体通知，不再触发全量会话刷新", async () => {
    let boots = 0;
    const refresh = deferred<Response>();
    const episodeClaim = { ...claim, dramaId: "drama-1", episodeId: "episode-3" };
    const playback = { status: "playable", drama: { id: "drama-1" }, episode: { id: "episode-3" },
      playback: { channel: "byteplus", albumId: "album-1", episodeId: "platform-3", vid: "vid-3" } };
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("session")) return ++boots === 1 ? json({ data: identity() }) : refresh.promise;
      return json({ data: { ...settlement, ...episodeClaim, rewardType: "episode_unlock", unlocked: true, playback } });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    store("A").add(episodeClaim);
    const events: EntitlementChange[] = [];
    runtime.subscribeEntitlements!((event) => events.push(event));
    const pending = runtime.retryPendingAdClaims();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ revision: 1, applicationId: "application", visitorId: "A", rewardType: "episode_unlock", dramaId: "drama-1", episodeId: "episode-3" });
    expect(events[0].playback).toEqual({ ...playback, playback: { ...playback.playback, provider: "tiktok_minis" } });
    expect(runtime.getEntitlementRevision!()).toBe(1);
    refresh.resolve(json({ code: 500, reason: "service_unavailable", message: "Request failed", data: null }, 503));
    await pending;
    expect(boots).toBe(1);
    expect(events).toHaveLength(1);
    expect(store("A").list()).toEqual([]);
  });

  it("直接VIP领取先应用权益再通知；订阅者错误不能把已确认奖励变回待领取", async () => {
    const startup = identity();
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => String(url).endsWith("session") ? json({ data: startup }) : json({ data: settlement })), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    expect(runtime.getAdExperience().vipState.active).toBe(false);
    const active: boolean[] = [];
    runtime.subscribeEntitlements!(() => { throw new Error("UI subscriber failed"); });
    runtime.subscribeEntitlements!(() => active.push(runtime.getAdExperience().vipState.active));
    await expect(runtime.claimReward(claim)).resolves.toMatchObject({ status: "granted" });
    expect(active).toEqual([true]);
    expect(runtime.getAdExperience().vipState.active).toBe(true);
    expect(store("A").list()).toEqual([]);
  });

  it("VIP 达标后只有显式领取响应才激活权益", async () => {
    const startup = identity();
    const progress = { ...startup.vipState, adCount: 1, active: false };
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("session")) return json({ data: startup });
      if (String(url).endsWith("/vip/claim")) return json({ data: { ...progress, active: true } });
      return json({ data: { ...settlement, vipState: progress } });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.claimReward(claim);
    expect(runtime.getAdExperience().vipState).toMatchObject(progress);
    const recheck = vi.fn();
    runtime.subscribeEntitlements!(recheck);
    await runtime.claimVIP();
    expect(runtime.getAdExperience().vipState.active).toBe(true);
    expect(recheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rewardType: "vip_progress" }));
  });
});

describe("待领取错误分类", () => {
  it.each(["granted", "already_granted"] as const)("直连 %s 回包前切换前后台，仍清除原领取、通知权益且不重复结算", async status => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const startup = identity();
    startup.playbackSdk = { provider: "byteplus_web", channel: "byteplus", capabilities: { mediaPreload: false } };
    startup.monetization.vip.enabled = false;
    const response = deferred<Response>();
    const episodeClaim = { ...claim, dramaId: "drama-1", episodeId: "episode-3" };
    const nextAd = { dramaId: "drama-1", episodeId: "episode-4", episodeNumber: 4, unlockedCount: 3, totalCount: 8,
      offer: { kind: "rewarded_episode", offerId: "next", adUnitId: "ad", autoUnlock: { enabled: true, countdownSeconds: 30 } } };
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("session") ? json({ data: startup }) : response.promise);
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, () => startup));
    try {
      const runtime = createRuntime(); await runtime.bootstrap(); fetcher.mockClear();
      const events: EntitlementChange[] = [];
      runtime.subscribeEntitlements!(event => events.push(event));
      const pending = runtime.claimReward(episodeClaim);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
      visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
      response.resolve(json({ data: { ...episodeClaim, status, rewardType: "episode_unlock", unlocked: true, nextAd,
        playback: { status: "playable", drama: { id: "drama-1" }, episode: { id: "episode-3" },
          playback: { channel: "byteplus", vid: "vid-3", playAuthToken: "private-test-token", expiresAt: new Date(Date.now() + 300_000).toISOString() } } } }));
      await expect(pending).resolves.toMatchObject({ status, unlocked: true, nextAd });
      expect(store("A").list()).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ rewardType: "episode_unlock", dramaId: "drama-1", episodeId: "episode-3" });
      expect(events[0].playback).toBeUndefined();
      await runtime.retryPendingAdClaims();
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(1);
    } finally { visibility.mockRestore(); }
  });

  it("并发领奖和后台补领共用一次请求且只发布一次权益", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("session") ? json({ data: identity() }) : response.promise);
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime(); await runtime.bootstrap(); fetcher.mockClear();
    const changed = vi.fn(); runtime.subscribeEntitlements!(changed);
    const first = runtime.claimReward(claim);
    const second = runtime.claimReward({ ...claim });
    const recovery = runtime.retryPendingAdClaims();
    response.resolve(json({ data: settlement }));
    await Promise.all([first, second, recovery]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store("A").list()).toEqual([]);
  });

  it("存在待领取时拒绝新广告，保留原领取供重试", async () => {
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => json({ data: identity() })), identity));
    const runtime = createRuntime(); await runtime.bootstrap();
    store("A").add(claim);
    await expect(runtime.showRewardedAd("ad", { ...claim, claimId: "new-claim" })).rejects.toMatchObject({ code: "reward_pending_confirmation" });
    expect(store("A").list()).toEqual([claim]);
  });
  it.each([
    [0, "network_error"],
    [200, "invalid_response"],
    [401, "unauthorized"],
    [503, "service_unavailable"],
  ])("HTTP %s / %s 未确认拒绝时保留原ClaimID", (status, code) => {
    expect(isRetryableClaimError(new ApiError("technical", status, code))).toBe(true);
  });

  it("明确业务拒绝才清除，不把未知4xx误当业务拒绝", () => {
    expect(isRetryableClaimError(new ApiError("rejected", 400, "invalid_reward_claim"))).toBe(false);
    expect(isRetryableClaimError(new ApiError("rejected", 409, "invalid_reward_claim"))).toBe(false);
    expect(isRetryableClaimError(new ApiError("unknown", 400))).toBe(true);
  });

  it("网络中断保留待领取，同账号恢复后使用原ClaimID确认并清除", async () => {
    let failed = true;
    const requests: string[] = [];
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("session")) return json({ data: identity() });
      requests.push(JSON.parse(String(init?.body)).claimId as string);
      if (failed) throw new TypeError("offline");
      return json({ data: settlement });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await expect(runtime.claimReward(claim)).rejects.toMatchObject({ status: 0, code: "network_error" });
    expect(store("A").list()).toEqual([claim]);
    failed = false;
    await runtime.retryPendingAdClaims();
    expect(requests).toEqual([claim.claimId, claim.claimId]);
    expect(store("A").list()).toEqual([]);
  });

  it("只有明确的业务拒绝会移除待领取", async () => {
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => String(url).endsWith("session")
      ? json({ data: identity() }) : json({ code: 500, reason: "invalid_reward_claim", message: "rejected", data: null }, 400)), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runtime.claimReward(claim)).rejects.toMatchObject({ code: "invalid_reward_claim" });
    expect(store("A").list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "reward_claim_rejected", error: "rejected" }));
    log.mockRestore();
  });
});

describe("广告与异步结算的原账号归属", () => {
  it("首次启动的观察者拒绝错误应用身份后，业务请求不能使用未安装身份", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ data: { ...identity(), applicationId: "wrong-application" } }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await expect(runtime.bootstrap()).rejects.toThrow();
    await expect(runtime.api.home()).rejects.toMatchObject({ status: 503, code: "identity_unavailable" });
    expect(runtime.getVisitorID()).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["recovery"])("%s遇到B错误应用身份后封闭身份，不得将A待领发给B；明确启动成功后恢复A补领", async (mode) => {
    let boots = 0;
    let successful = false;
    const tokens: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("session")) {
        boots += 1;
        return json({ data: boots === 2 ? { ...identity("B"), applicationId: "wrong-application" } : identity() });
      }
      tokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return successful ? json({ data: settlement }) : json({ code: 500, reason: "unauthorized", message: "Request failed", data: null }, 401);
    });
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    if (mode === "recovery") await expect(runtime.claimReward(claim)).rejects.toThrow();
    else { store("A").add(claim); await expect(runtime.refreshBootstrap()).rejects.toThrow(); }
    const requestCount = tokens.length;
    await runtime.retryPendingAdClaims();
    expect(tokens).toHaveLength(requestCount);
    expect(store("A").list()).toEqual([claim]);
    expect(runtime.getVisitorID()).toBe("A");
    successful = true;
    await runtime.refreshBootstrap();
    await runtime.retryPendingAdClaims();
    expect(tokens.every((token) => token === "Bearer token-A")).toBe(true);
    await vi.waitFor(() => expect(store("A").list()).toEqual([]));
  });

  it("已确认领奖后不额外全量刷新，避免非关键配置故障阻塞已解锁播放", async () => {
    let boots = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("session")) return json({ data: ++boots === 1 ? identity() : { ...identity("B"), applicationId: "wrong-application" } });
      return json({ data: settlement });
    });
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await expect(runtime.claimReward(claim)).resolves.toMatchObject({ status: "granted" });
    expect(store("A").list()).toEqual([]);
    await expect(runtime.api.home()).resolves.toBeDefined();
    expect(boots).toBe(1);
    expect(runtime.getSessionState!()).toBe("ready");
    expect(runtime.getVisitorID()).toBe("A");
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(1);
  });

  it("广告过程中切换账号，完成记录留在A；拷贝对象或再次展示不能转到B", async () => {
    let visitorId = "A";
    const fetcher = vi.fn<typeof fetch>(async () => json({ data: identity(visitorId) }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    const completed = expect(runtime.showRewardedAd("ad", claim)).rejects.toMatchObject({ code: "identity_changed" });
    visitorId = "B";
    await runtime.refreshBootstrap();
    platform.closeRewardedAd({ isEnded: true });
    await completed;
    expect(store("A").list()).toEqual([claim]);
    expect(store("B").list()).toEqual([]);
    await expect(runtime.claimReward({ ...claim })).rejects.toMatchObject({ code: "identity_changed" });
    await expect(runtime.showRewardedAd("ad", { ...claim })).rejects.toMatchObject({ code: "identity_changed" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(0);
  });

  it("旧调用缺少ClaimID或同ClaimID并发展示时拒绝启动", async () => {
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => json({ data: identity() })), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await expect(runtime.showRewardedAd("ad")).rejects.toMatchObject({ code: "reward_context_invalid" });
    const shown = runtime.showRewardedAd("ad", claim);
    await expect(runtime.showRewardedAd("ad", { ...claim })).rejects.toMatchObject({ code: "reward_context_invalid" });
    platform.closeRewardedAd({ isEnded: true });
    await expect(shown).resolves.toEqual({ status: "completed" });
  });

  it.each([false, true])("广告超时后迟到完播保留原ClaimID，切号=%s 时不把奖励交给新账号", async (switchViewer) => {
    let visitorId = "A";
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("session")
      ? json({ data: identity(visitorId) }) : json({ data: settlement }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    let close!: (value: { isEnded: boolean }) => void;
    const create = vi.spyOn(platform.sdk, "createRewardedVideoAd").mockImplementation(() => ({
      show: () => new Promise<void>(() => {}),
      onClose: fn => { close = fn; }, onError: vi.fn(), offClose: vi.fn(), offError: vi.fn(),
    }));
    const first = runtime.showRewardedAd("ad", claim);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toEqual({ status: "unknown" });
    expect(runtime.isFullscreenAdActive?.()).toBe(false);
    expect(await runtime.showRewardedAd("ad", { ...claim, claimId: "blocked-second" })).toEqual({ status: "unknown" });
    expect(create).toHaveBeenCalledOnce();
    if (switchViewer) { visitorId = "B"; await runtime.refreshBootstrap(); }
    close({ isEnded: true }); close({ isEnded: true });
    expect(runtime.isFullscreenAdActive?.()).toBe(false);
    expect(store("A").list()).toEqual([claim]);
    expect(store("B").list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    const metrics = fetcher.mock.calls.filter(([url]) => String(url).endsWith("metrics"))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<{ kind: string; id: string }> }).events);
    const completedMetrics = metrics.filter(event => event.kind === "rewarded_complete");
    expect(completedMetrics).toHaveLength(switchViewer ? 0 : 1);
    if (!switchViewer) expect(metrics.find(event => event.kind === "rewarded_show")?.id).toBe(completedMetrics[0].id);
    if (switchViewer) {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(0);
    } else {
      await runtime.retryPendingAdClaims();
      const requests = fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"));
      expect(requests).toHaveLength(1);
      expect(JSON.parse(String(requests[0][1]?.body)).claimId).toBe(claim.claimId);
      expect(store("A").list()).toEqual([]);
    }
  });

  it("超时后一直无回调不锁住视频，反复重试不创建第二个广告也不请求发奖", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ data: identity() }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime(); await runtime.bootstrap();
    const native = pendingNativeAd();
    const changed = vi.fn(); runtime.subscribeEntitlements!(changed);
    const first = runtime.showRewardedAd("ad", claim);
    expect(runtime.isFullscreenAdActive?.()).toBe(true);
    await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
    expect(await first).toEqual({ status: "unknown" });
    expect(runtime.isFullscreenAdActive?.()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await runtime.showRewardedAd("ad", { ...claim, claimId: `retry-${attempt}` })).toEqual({ status: "unknown" });
      await runtime.retryPendingAdClaims();
    }
    expect(runtime.isFullscreenAdActive?.()).toBe(false);
    expect(native.create).toHaveBeenCalledOnce();
    expect(store("A").list()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(0);
    native.error();
  });

  it.each([false, true])("A→B→A 在迟到完播前恢复 A=%s 时自动补领一次，并发重试和旧回调不重复请求或发奖", async (restoreBeforeClose) => {
    let visitorId = "A";
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("session")
      ? json({ data: identity(visitorId) }) : String(url).endsWith("reward-grants") ? response.promise : json({ data: {} }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime(); await runtime.bootstrap();
    const native = pendingNativeAd();
    const events: EntitlementChange[] = []; runtime.subscribeEntitlements!(event => events.push(event));
    const first = runtime.showRewardedAd("ad", claim);
    await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs);
    expect(await first).toEqual({ status: "unknown" });
    visitorId = "B"; await runtime.refreshBootstrap();
    await runtime.retryPendingAdClaims();
    if (restoreBeforeClose) { visitorId = "A"; await runtime.refreshBootstrap(); }
    native.close(); native.close(); native.shown.resolve(); native.error();
    expect(store("A").list()).toEqual([claim]);
    expect(store("B").list()).toEqual([]);
    if (!restoreBeforeClose) {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(0);
      visitorId = "A"; await runtime.refreshBootstrap();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    const requests = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"));
    expect(requests()).toHaveLength(1);
    expect(JSON.parse(String(requests()[0][1]?.body))).toMatchObject({ claimId: claim.claimId, offerId: claim.offerId,
      completedAdUnitId: claim.adUnitId, isEnded: true });
    expect(new Headers(requests()[0][1]?.headers).get("authorization")).toBe("Bearer token-A");
    const retry = runtime.retryPendingAdClaims();
    await expect(runtime.claimReward({ ...claim })).rejects.toMatchObject({ code: "identity_changed" });
    await expect(runtime.showRewardedAd("ad", { ...claim, claimId: "next-ad" })).rejects.toMatchObject({ code: "reward_pending_confirmation" });
    expect(requests()).toHaveLength(1);
    response.resolve(json({ data: settlement }));
    await retry; await vi.advanceTimersByTimeAsync(1);
    native.close(); native.error();
    await expect(runtime.claimReward({ ...claim })).rejects.toMatchObject({ code: "identity_changed" });
    await runtime.retryPendingAdClaims(); await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toHaveLength(1);
    expect(native.create).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ applicationId: "application", visitorId: "A", revision: 1 });
    expect(runtime.getAdExperience().vipState.active).toBe(true);
    expect(store("A").list()).toEqual([]);
    expect(store("B").list()).toEqual([]);
  });

  it("A→B→A 跨代际补领加入同一在途请求，旧页面不能更新权益，当前队列以原键取得服务器最新状态", async () => {
    let visitorId = "A";
    const response = deferred<Response>();
    let rewards = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("session")
      ? json({ data: identity(visitorId) }) : String(url).endsWith("reward-grants") ? (++rewards === 1 ? response.promise : json({ data: { ...settlement, status: "already_granted", vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "next-day" } } })) : json({ data: {} }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime(); await runtime.bootstrap();
    const events = vi.fn(); runtime.subscribeEntitlements!(events);
    const first = expect(runtime.claimReward(claim)).rejects.toMatchObject({ code: "identity_changed" });
    await vi.advanceTimersByTimeAsync(1);
    visitorId = "B"; await runtime.refreshBootstrap();
    visitorId = "A"; await runtime.refreshBootstrap();
    const recovery = runtime.retryPendingAdClaims();
    const requests = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"));
    expect(requests()).toHaveLength(1);
    response.resolve(json({ data: settlement }));
    await first; await recovery;
    expect(events).not.toHaveBeenCalled();
    expect(runtime.getAdExperience().vipState.active).toBe(false);
    expect(store("A").list()).toEqual([claim]);
    await runtime.retryPendingAdClaims();
    expect(requests()).toHaveLength(2);
    expect(events).toHaveBeenCalledTimes(1);
    expect(runtime.getAdExperience().vipState.active).toBe(false);
    expect(runtime.getAdExperience().vipState).toMatchObject({ adCount: 0, progressDate: "next-day" });
    expect(store("A").list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests()).toHaveLength(2);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("批量补领第一条401恢复为B后立即停止，A后续记录和B同ID记录均不被删除", async () => {
    let boots = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("session")) return json({ data: identity(++boots === 1 ? "A" : "B") });
      requests.push(JSON.parse(String(init?.body)).claimId as string);
      return json({ code: 500, reason: "unauthorized", message: "credential invalid", data: null }, 401);
    }), identity));
    const second = { ...claim, claimId: "claim-a-0002" };
    store("A").add(claim); store("A").add(second); store("B").add(claim);
    const runtime = createRuntime();
    await runtime.bootstrap();
    await vi.waitFor(() => expect(runtime.getVisitorID()).toBe("B"));
    expect(requests).toEqual([claim.claimId]);
    expect(store("A").list()).toEqual([claim, second]);
    expect(store("B").list()).toEqual([claim]);
    expect(runtime.getAdExperience().vipState.active).toBe(false);
  });

  it("A的在途成功响应不能更新B的VIP，也不能删除B同ClaimID的记录", async () => {
    let visitorId = "A";
    const response = deferred<Response>();
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => String(url).endsWith("session")
      ? json({ data: identity(visitorId) }) : response.promise), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    const pending = expect(runtime.claimReward(claim)).rejects.toMatchObject({ code: "identity_changed" });
    visitorId = "B";
    store("B").add(claim);
    await runtime.refreshBootstrap();
    response.resolve(json({ data: settlement }));
    await pending;
    expect(store("A").list()).toEqual([claim]);
    expect(store("B").list()).toEqual([claim]);
    expect(runtime.getAdExperience().vipState.active).toBe(false);
  });
});

describe("VIP 到期与播放响应同步", () => {
  it("回前台只使用现有凭据查询权益；再次切后台取消旧查询，迟到结果不能覆盖最新进度", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const first = deferred<Response>();
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith("session")) return json({ data: identity() });
      if (String(url).endsWith("/me/vip")) {
        if (++reads === 1) return first.promise;
        return json({ data: { ...identity(), vipState: { ...identity().vipState, adCount: 1 } } });
      }
      return json({ data: { accepted: true } });
    });
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const hide = () => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); };
    const show = () => { visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); };
    hide(); show();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    const firstInit = fetcher.mock.calls.find(([url]) => String(url).endsWith("/me/vip"))![1]!;
    expect(new Headers(firstInit.headers).get("authorization")).toBe("Bearer token-A");
    hide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(firstInit.signal?.aborted).toBe(true);
    expect(runtime.getAdExperience().refreshError).toBeUndefined();
    show();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: false, vipState: { adCount: 1 } });
    first.resolve(json({ data: identity() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getAdExperience().vipState.adCount).toBe(1);
    expect(platform.sdk.login).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("session"))).toHaveLength(1);
    visibility.mockRestore();
  });

  it("新版状态接口缺失时提供局部重试，不回退旧聚合启动或重复登录", async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith("/me/vip")
      ? json({ code: 404, reason: "not_found" }, 404) : json({ data: identity() }));
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    await expect(runtime.refreshAdExperience()).rejects.toMatchObject({ status: 404 });
    await expect(runtime.refreshAdExperience()).rejects.toMatchObject({ status: 404 });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/me/vip"))).toHaveLength(2);
    expect(platform.sdk.login).toHaveBeenCalledOnce();
    expect(runtime.getAdExperience().refreshRequired).toBe(true);
  });
  it("领奖重新验权但复用媒体缓存，VIP 到期与换号清除媒体信息和字节", async () => {
    vi.setSystemTime(new Date("2026-09-17T00:00:00Z"));
    vi.stubGlobal("MediaSource", class {});
    const ctor = Object.assign(class {}, {
      prepare: vi.fn(async () => {}), setPreloadScene: vi.fn(), setPreloadList: vi.fn(async () => {}),
      clearMediaInfoCache: vi.fn(),
      preloader: { clearPreloadList: vi.fn(), removeAllPreloadTask: vi.fn(), removeAll: vi.fn() },
    });
    let visitor = "A";
    const resolve = vi.fn(() => json({ data: { status: "unavailable" } }));
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("session") || String(url).endsWith("/me/vip")) return json({ data: identity(visitor) });
      if (String(url).split("?", 1)[0]?.endsWith("/play/resolve")) return resolve();
      return json({ data: { ...settlement, vipState: { ...settlement.vipState, validUntil: "2026-09-17T00:00:01Z" } } });
    }), identity));
    const runtime = createRuntime({ getConstructor: async () => ctor as unknown as TikTokVePlayerConstructor });
    await runtime.bootstrap();
    await runtime.preparePlayback!();
    await runtime.resolvePlayback!("drama", "episode");
    ctor.preloader.removeAllPreloadTask.mockClear();
    await runtime.claimReward(claim);
    await runtime.resolvePlayback!("drama", "episode");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(ctor.preloader.removeAllPreloadTask).not.toHaveBeenCalled();
    expect(ctor.preloader.removeAll).not.toHaveBeenCalled();
    expect(ctor.clearMediaInfoCache).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ctor.preloader.removeAll).toHaveBeenCalledOnce();
    expect(ctor.clearMediaInfoCache).toHaveBeenCalledOnce();
    visitor = "B";
    await runtime.refreshBootstrap();
    expect(ctor.preloader.removeAll).toHaveBeenCalledTimes(2);
    expect(ctor.clearMediaInfoCache).toHaveBeenCalledTimes(2);
  });

  const vipOffer = { offerId: "offer", kind: "rewarded_vip" as const, adUnitId: "ad" };
  it("播放接口确认 VIP 失效后可再次看广告，不需要重新登录", async () => {
    const active = { ...identity().vipState, active: true, adCount: 1 };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("session")) return json({ data: { ...identity(), vipState: active, vipOffer } });
      if (String(url).split("?", 1)[0]?.endsWith("/play/resolve")) return json({ data: { status: "access_required", vipState: identity().vipState, offer: vipOffer } });
      return json({ data: { ...settlement, claimId: JSON.parse(String(init?.body)).claimId } });
    });
    vi.stubGlobal("fetch", splitConsumerFetch(fetcher, identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    await runtime.api.resolvePlay("drama", "episode");
    expect(runtime.getAdExperience().vipState.active).toBe(false);
    const watched = runtime.watchVIPAd(vipOffer);
    platform.closeRewardedAd({ isEnded: true });
    await expect(watched).resolves.toMatchObject({ rewardType: "vip_progress", vipState: { active: true } });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("session"))).toHaveLength(1);
  });

  it("validUntil 到期先标记待刷新，服务端确认后才撤去 VIP；手机日期变化不提前失效", async () => {
    vi.setSystemTime(new Date("2026-09-05T15:59:59Z"));
    const pending = deferred<Response>();
    let boots = 0;
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async url => {
      if (!String(url).endsWith("session") && !String(url).endsWith("/me/vip")) return json({ data: { accepted: true } });
      if (++boots > 1) return pending.promise;
      return json({ serverTime: "2026-09-05T15:59:59Z", data: { ...identity(), vipState: {
        ...identity().vipState, active: true, adCount: 1, validUntil: "2026-09-05T16:00:00Z",
      }, vipOffer } });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const listener = vi.fn();
    runtime.subscribeEntitlements!(listener);
    vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(999);
    expect(runtime.getAdExperience().vipState.active).toBe(true);
    expect(runtime.getAdExperience().refreshRequired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: true, vipState: { active: true, adCount: 1 } });
    expect(boots).toBe(2);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cause: "vip_recheck", rewardType: "vip_progress", visitorId: "A" }));
    pending.resolve(json({ serverTime: "2026-09-05T16:00:01Z", data: identity() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: false, vipState: { active: false, adCount: 0 } });
  });

  it("WebView 后台单调时钟暂停也在回前台重新确认 VIP，不按手机日期撤销权益", async () => {
    vi.setSystemTime(new Date("2026-09-05T15:59:59Z"));
    const pending = deferred<Response>();
    let boots = 0;
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async url => {
      if (!String(url).endsWith("session") && !String(url).endsWith("/me/vip")) return json({ data: { accepted: true } });
      if (++boots > 1) return pending.promise;
      return json({ data: { ...identity(), vipState: { ...identity().vipState, active: true, adCount: 1, validUntil: "2026-09-05T16:00:00Z" } } });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
    visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: true, vipState: { active: true } });
    expect(boots).toBe(2);
    pending.resolve(json({ serverTime: "2026-09-06T00:00:00Z", data: { ...identity(), vipState: {
      ...identity().vipState, active: true, validUntil: "2026-09-07T00:00:00Z",
    } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: false, vipState: { active: true } });
    visibility.mockRestore();
  });

  it("VIP 到期刷新失败保留已确认状态和安全恢复入口，不循环请求，也不重拉广告", async () => {
    vi.setSystemTime(new Date("2026-09-05T15:59:59Z"));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let boots = 0;
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async url => {
      if (!String(url).endsWith("session") && !String(url).endsWith("/me/vip")) return json({ data: { accepted: true } });
      boots++;
      if (boots === 1) return json({ data: { ...identity(), vipState: { ...identity().vipState, active: true, validUntil: "2026-09-05T16:00:00Z" } } });
      if (boots === 2) throw new Error("network unavailable token=private-token");
      return json({ data: identity() });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: true, vipState: { active: true } });
    expect(runtime.getAdExperience().refreshError).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(boots).toBe(2);
    await expect(runtime.watchVIPAd(vipOffer)).rejects.toMatchObject({ code: "invalid_response" });
    expect(platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).toContain("vip_state_refresh_failed");
    expect(JSON.stringify(log.mock.calls)).toContain("network unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
    await runtime.refreshAdExperience();
    expect(runtime.getAdExperience()).toMatchObject({ refreshRequired: false, vipState: { active: false } });
  });

  it("领奖前的迟到播放响应不能撤销刚到账的 VIP", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("session")) return json({ data: identity() });
      if (String(url).split("?", 1)[0]?.endsWith("/play/resolve")) return pending.promise;
      return json({ data: settlement });
    }), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    const resolving = runtime.api.resolvePlay("drama", "episode");
    await runtime.claimReward(claim);
    pending.resolve(json({ data: { status: "access_required", vipState: identity().vipState, offer: vipOffer } }));
    await resolving;
    expect(runtime.getAdExperience().vipState.active).toBe(true);
  });

  it("换号后旧账号有效期不能撤销新账号的 VIP", async () => {
    vi.setSystemTime(new Date("2026-09-05T15:59:59Z"));
    let visitor = "A";
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => json({ data: { ...identity(visitor), vipState: {
      ...identity().vipState, active: true, validUntil: visitor === "A" ? "2026-09-05T16:00:00Z" : "2026-09-06T16:00:00Z",
    } } })), identity));
    const runtime = createRuntime();
    await runtime.bootstrap();
    visitor = "B";
    await runtime.refreshBootstrap();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getVisitorID()).toBe("B");
    expect(runtime.getAdExperience().vipState.active).toBe(true);
  });
});
