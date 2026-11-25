import { splitConsumerFetch } from "../test/splitConsumerFetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  executeVIPRewardedAd,
  readLaunchQuery,
  type Runtime,
} from "./runtime";
import type {
  BootstrapResult,
  ClaimResult,
  RewardClaim,
} from "../domain/types";
import { ApiError, HttpMiniDramaApi } from "../api/httpMiniDramaApi";
import { userMessage } from "../api/userMessage";
import { text } from "../copy";
import { TikTokMinisPlayerEngine } from "../player/tiktokMinisPlayerEngine";
import { OfficialTikTokMinisPlayerAdapter } from "../player/tiktokMinisPlayerAdapter";
import { createTikTokFixture } from "../test/tiktokFixture";

const startup = (): BootstrapResult => ({
  applicationId: "application", tiktokAppId: "test-app", visitorId: "visitor", visitorToken: "test-visitor-token",
  appName: "Test Drama", logoUrl: "", complianceBaseUrl: "", identityState: "tiktok_authenticated",
  playbackSdk: { provider: "tiktok_minis", channel: "byteplus" },
  vipState: { active: false, adCount: 0, requiredCount: 5, progressDate: "today" },
  vipOffer: { offerId: "vip-offer", kind: "rewarded_vip", adUnitId: "vip-placement" },
  monetization: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1,
    episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
    vip: { enabled: true, requiredAdCount: 5, title: "", content: "" } },
});
const response = (data: unknown) => new Response(JSON.stringify({ data }));
const entryResponse = (dramaId: string, episodeId: string) => ({ entry: {
  target: { dramaId, episodeId }, drama: { id: dramaId, coverUrl: "" }, episode: { id: episodeId, dramaId, posterUrl: "" },
  entryAdStatus: { enabled: false, completedCount: 0, requiredCount: 0 }, vipState: startup().vipState,
} });
let platform: ReturnType<typeof createTikTokFixture>;
beforeEach(() => {
  // Runtime 会安装统计和补领定时器；统一控制时钟，避免真实任务在测试环境销毁后继续访问 window。
  vi.useFakeTimers();
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  platform = createTikTokFixture();
  window.TTMinis = platform.sdk;
  vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response(startup())), startup));
});

describe("readLaunchQuery", () => {
  it("keeps TikTok acquisition and content targets but rejects other platform overrides", () => {
    expect(readLaunchQuery("?tiktokAppId=foreign&campaignCode=tiktok-id&dramaId=drama-1&episodeId=episode-1&ttclid=click-1&fbclid=meta-1&gclid=google-1&debug=true")).toEqual({
      campaignCode: "tiktok-id",
      dramaId: "drama-1",
      episodeId: "episode-1",
      ttclid: "click-1",
    });
  });
});

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.TTMinis;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it("入剧展示提前关闭也确认事实，展示确认故障保留原键补报且不申请奖励", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const report = vi.spyOn(HttpMiniDramaApi.prototype, "recordAdShow")
    .mockRejectedValueOnce(new Error("display confirmation connection lost"))
    .mockResolvedValue({ accepted: true });
  const runtime = createRuntime();
  await runtime.bootstrap();
  const input = { claimId: "entry-display-key", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" };
  const pending = expect(runtime.showEntryAd(input)).rejects.toThrow("display confirmation connection lost");
  await vi.waitFor(() => expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalled());
  platform.closeRewardedAd({ isEnded: false });
  await pending;
  expect(runtime.hasPendingAdClaim()).toBe(false);
  expect(report).toHaveBeenCalledOnce();
  const show = report.mock.calls[0][0];
  expect(show).toMatchObject({ eventId: input.claimId, scene: "entry_reward", adUnitId: input.adUnitId, dramaId: input.dramaId });
  expect(show.occurredAt).toBeUndefined();
  expect(log.mock.calls.some(call => JSON.stringify(call).includes("display confirmation connection lost"))).toBe(true);
  await runtime.retryPendingAdShows();
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[1][0]).toMatchObject(show);
  await runtime.retryPendingAdShows();
  expect(report).toHaveBeenCalledTimes(2);
});

it("入剧广告展示前换号，事实留在原用户，切回后使用原键确认", async () => {
  const report = vi.spyOn(HttpMiniDramaApi.prototype, "recordAdShow").mockResolvedValue({ accepted: true });
  let viewer = "viewer-A";
  vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response({ ...startup(), visitorId: viewer })), startup));
  const runtime = createRuntime();
  await runtime.bootstrap();
  // 展示 Promise 尚未兑现时换号，完播证明仍绑定广告发起时的主体。
  const ad = platform.sdk.createRewardedVideoAd!({ adUnitId: "entry-ad" });
  vi.spyOn(platform.sdk, "createRewardedVideoAd").mockReturnValue({ ...ad, show: () => new Promise<void>(() => {}) });
  const input = { claimId: "entry-owner-key", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" };
  const pending = expect(runtime.showEntryAd(input)).rejects.toMatchObject({ code: "identity_changed" });
  await vi.waitFor(() => expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalled());
  viewer = "viewer-B";
  await runtime.api.createSession({ tiktokAppId: "test-app", launchQuery: {} });
  platform.closeRewardedAd({ isEnded: true });
  await pending;
  expect(report).not.toHaveBeenCalled();
  await runtime.retryPendingAdShows();
  expect(report).not.toHaveBeenCalled();
  viewer = "viewer-A";
  await runtime.api.createSession({ tiktokAppId: "test-app", launchQuery: {} });
  await runtime.retryPendingAdShows();
  expect(report).toHaveBeenCalledOnce();
  expect(report.mock.calls[0][0]).toMatchObject({ eventId: input.claimId, scene: "entry_reward", dramaId: input.dramaId });
});

async function completeVIPAd(runtime: Runtime) {
  const pending = runtime.watchVIPAd();
  await vi.advanceTimersByTimeAsync(0);
  platform.closeRewardedAd({ isEnded: true });
  return pending;
}

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 实际 Runtime 静默恢复沿用原 ClaimID，原生尝试分别统计且仅成功展示和完播结算一次", async provider => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const configured = () => ({ ...startup(), playbackSdk: { provider, channel: "byteplus" as const,
    ...(provider === "byteplus_web" ? { capabilities: { mediaPreload: false } } : {}) } });
  vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response(configured())), configured));
  const runtime = createRuntime();
  await runtime.bootstrap();
  const collect = vi.spyOn(HttpMiniDramaApi.prototype, "collectMetrics").mockResolvedValue({ accepted: true });
  const report = vi.spyOn(runtime.api, "recordAdShow").mockResolvedValue({ accepted: true });
  const claim = { claimId: "entry-silent-recovery", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" };
  const reward = vi.spyOn(runtime.api, "claimReward").mockResolvedValue({ claimId: claim.claimId, status: "granted", rewardType: "entry_progress", unlocked: false, dramaId: claim.dramaId, episodeId: "", vipState: startup().vipState });
  const create = vi.mocked(platform.sdk.createRewardedVideoAd);
  const original = create.getMockImplementation()!;
  create.mockImplementationOnce(options => ({ ...original(options), show: async () => {
    throw { errorCode: "101150000", subErrorCode: "50008", errMsg: "container unavailable token=private-value" };
  } }));
  const pending = runtime.showEntryAd(claim);
  await vi.advanceTimersByTimeAsync(0);
  expect(create).toHaveBeenCalledOnce();
  expect(runtime.isFullscreenAdActive!()).toBe(true);
  expect(report).not.toHaveBeenCalled();
  expect(reward).not.toHaveBeenCalled();
  expect(runtime.hasPendingAdClaim()).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(create).toHaveBeenCalledTimes(2);
  platform.closeRewardedAd({ isEnded: true });
  await expect(pending).resolves.toMatchObject({ status: "completed" });
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventId: claim.claimId }));
  expect(reward).not.toHaveBeenCalled();
  await runtime.claimReward(claim);
  expect(reward).toHaveBeenCalledExactlyOnceWith(claim);
  await vi.advanceTimersByTimeAsync(3_000);
  const facts = collect.mock.calls.flatMap(([events]) => events);
  const requests = facts.filter(event => event.kind === "ad_request");
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map(event => event.id)).size).toBe(2);
  expect(facts.filter(event => event.kind === "ad_failure")).toHaveLength(1);
  expect(facts.filter(event => event.kind === "ad_shown")).toMatchObject([{ id: requests[1].id }]);
  expect(facts.filter(event => event.kind === "rewarded_show")).toHaveLength(1);
  expect(facts.filter(event => event.kind === "rewarded_complete")).toHaveLength(1);
});

it.each([false, true])("静默等待换号后停止旧主体请求，切回原账号也不恢复旧代次：切回=%s", async restore => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let viewer = "visitor";
  vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response({ ...startup(), visitorId: viewer })), startup));
  const runtime = createRuntime();
  await runtime.bootstrap();
  const create = vi.mocked(platform.sdk.createRewardedVideoAd);
  const original = create.getMockImplementation()!;
  create.mockImplementationOnce(options => ({ ...original(options), show: async () => {
    throw { subErrorCode: "50008", errMsg: "container unavailable" };
  } }));
  const claim = { claimId: "old-viewer-recovery", offerId: "offer", adUnitId: "slot" };
  const pending = runtime.showRewardedAd(claim.adUnitId, claim);
  await vi.advanceTimersByTimeAsync(0);
  viewer = "other-viewer";
  await runtime.api.createSession({ tiktokAppId: "test-app", launchQuery: {} });
  if (restore) {
    viewer = "visitor";
    await runtime.api.createSession({ tiktokAppId: "test-app", launchQuery: {} });
  }
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(pending).resolves.toMatchObject({ status: "failed", reason: "stale_intent" });
  expect(create).toHaveBeenCalledOnce();
  expect(runtime.hasPendingAdClaim()).toBe(false);
});

it("完整观看模式的展示确认未返回或失败不阻止奖励，原展示仍能补报", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let rejectReport: ((reason: Error) => void) | undefined;
  const report = vi.spyOn(HttpMiniDramaApi.prototype, "recordAdShow")
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectReport = reject; }))
    .mockResolvedValue({ accepted: true });
  const reward = vi.spyOn(HttpMiniDramaApi.prototype, "claimReward").mockResolvedValue({ claimId: "entry-complete-key",
    status: "granted", rewardType: "entry_progress", unlocked: false, dramaId: "201", episodeId: "" });
  const runtime = createRuntime();
  await runtime.bootstrap();
  const input = { claimId: "entry-complete-key", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" };
  const pending = runtime.showEntryAd(input, false);
  await vi.waitFor(() => expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalled());
  platform.closeRewardedAd({ isEnded: true });
  await expect(pending).resolves.toMatchObject({ status: "completed" });
  await runtime.claimReward(input);
  expect(reward).toHaveBeenCalledOnce();
  rejectReport?.(new Error("display offline"));
  await Promise.resolve();
  await runtime.retryPendingAdShows("entry_reward");
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[1][0]).toMatchObject(report.mock.calls[0][0]);
});

describe("single-placement VIP rewarded ad settlement", () => {
  const rewardClaim: RewardClaim = {
    claimId: "claim-vip-00000001",
    offerId: "offer-vip-1",
    adUnitId: "primary",
  };
  const claim: ClaimResult = {
    claimId: rewardClaim.claimId,
    status: "granted",
    unlocked: false,
    dramaId: "",
    episodeId: "",
    rewardType: "vip_progress",
  };

  it("claims the only configured placement after a complete view", async () => {
    const showAd = vi.fn().mockResolvedValue({ status: "completed" });
    const claimCompleted = vi.fn(async () => claim);

    await expect(
      executeVIPRewardedAd(
        rewardClaim,
        showAd,
        claimCompleted,
      ),
    ).resolves.toEqual({ status: "completed", claim });

    expect(showAd.mock.calls).toEqual([["primary"]]);
    expect(claimCompleted).toHaveBeenCalledWith(rewardClaim);
  });

  it("does not fall back to another placement when the configured ad fails", async () => {
    const showAd = vi.fn(async () => ({ status: "failed" as const }));
    const claimCompleted = vi.fn(async () => claim);

    await expect(
      executeVIPRewardedAd(rewardClaim, showAd, claimCompleted),
    ).resolves.toEqual({ status: "unavailable" });

    expect(showAd.mock.calls).toEqual([["primary"]]);
    expect(claimCompleted).not.toHaveBeenCalled();
  });

  it("stops the current opportunity when the user closes an ad early", async () => {
    const showAd = vi.fn(async () => ({ status: "cancelled" as const }));
    const claimCompleted = vi.fn(async () => claim);

    await expect(
      executeVIPRewardedAd(
        rewardClaim,
        showAd,
        claimCompleted,
      ),
    ).resolves.toEqual({ status: "cancelled" });

    expect(showAd).toHaveBeenCalledTimes(1);
    expect(claimCompleted).not.toHaveBeenCalled();
  });

  it("keeps a completed claim pending when confirmation is interrupted", async () => {
    const showAd = vi.fn(async () => ({ status: "completed" as const }));
    const claimCompleted = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      executeVIPRewardedAd(rewardClaim, showAd, claimCompleted),
    ).resolves.toEqual({ status: "pending" });
  });

  it("treats a deterministic server rejection as a failed opportunity", async () => {
    const showAd = vi.fn(async () => ({ status: "completed" as const }));
    const claimCompleted = vi.fn(async () => {
      throw new ApiError("invalid reward claim", 409, "invalid_reward_claim");
    });

    await expect(
      executeVIPRewardedAd(rewardClaim, showAd, claimCompleted),
    ).resolves.toEqual({ status: "rejected" });
  });
});

describe("VIP 广告故障分类", () => {
  it("平台就绪后并行采集系统版本，正常广告不携带诊断", async () => {
    platform.sdk.getSystemInfoSync = () => ({ version: "46.1.0", platform: "android" });
    const report = vi.spyOn(HttpMiniDramaApi.prototype, "reportAdErrors").mockResolvedValue({ accepted: true });
    const runtime = createRuntime();
    await runtime.whenPlatformReady!();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const collect = vi.spyOn(HttpMiniDramaApi.prototype, "collectMetrics").mockResolvedValue({ accepted: true });
    const pending = runtime.watchVIPAd();
    await vi.waitFor(() => expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalled());
    platform.closeRewardedAd({ isEnded: false }); await pending;
    await vi.advanceTimersByTimeAsync(3000);
    const phases = collect.mock.calls.flatMap(call => call[0]).filter(event => event.ad);
    expect(report).not.toHaveBeenCalled();
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.every(event => event.ad?.os === "android" && event.ad?.tiktokVersion === "46.1.0")).toBe(true);
    expect(phases.every(event => !("adFailure" in event))).toBe(true); // 正常广告只统计，不上传诊断。
  });

  it("宿主系统诊断字段异常不阻断广告，并使用有界的未知维度上报", async () => {
    platform.sdk.getSystemInfoSync = () => ({ version: "9".repeat(40), platform: 123 as unknown as string });
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const collect = vi.spyOn(HttpMiniDramaApi.prototype, "collectMetrics").mockResolvedValue({ accepted: true });
    const pending = runtime.watchVIPAd();
    await vi.waitFor(() => expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalled());
    platform.closeRewardedAd({ isEnded: false });
    await expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    const phases = collect.mock.calls.flatMap(call => call[0]).filter(event => event.ad);
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.every(event => event.ad?.os === "unknown" && event.ad?.tiktokVersion === "unknown")).toBe(true);
  });

  it("SDK 拉起失败保留实际原因，提示广告故障，不结算且可再次尝试", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const show = vi.fn().mockRejectedValue(new Error("ad inventory unavailable token=private-value https://ads.example/private"));
    const ad = platform.sdk.createRewardedVideoAd({ adUnitId: "vip-placement" });
    vi.spyOn(platform.sdk, "createRewardedVideoAd").mockReturnValue({ ...ad, show });
    const collect = vi.spyOn(HttpMiniDramaApi.prototype, "collectMetrics").mockResolvedValue({ accepted: true });
    const report = vi.spyOn(HttpMiniDramaApi.prototype, "reportAdErrors").mockResolvedValue({ accepted: true });
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const claim = vi.spyOn(runtime.api, "claimReward");

    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await runtime.watchVIPAd().catch(reason => reason);
      expect(error).toMatchObject({ code: "rewarded_ad_unavailable" });
      expect(error.message).toBe("ad inventory unavailable token=[REDACTED] [URL]");
      expect(userMessage(error, text("vip.grantError"))).toBe(text("runtime.rewardedAdFailed"));
      expect(runtime.isFullscreenAdActive?.()).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(show).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledOnce(); // 第二个失败仍受十秒间隔约束。
    const logged = report.mock.calls[0][0][0];
    const counted = collect.mock.calls.flatMap(([events]) => events).find(event => event.id === logged.id && event.kind === "ad_failure");
    expect(counted?.ad?.stage).toBe("show");
    expect(counted).not.toHaveProperty("adFailure");
    expect(logged.failure.error).toBe("ad inventory unavailable token=[REDACTED] [URL]");
    expect(claim).not.toHaveBeenCalled();
    expect(runtime.hasPendingAdClaim()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "rewarded_ad_show_failed", stage: "show", error: "ad inventory unavailable token=[REDACTED] [URL]" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-value");
    expect(JSON.stringify(log.mock.calls)).not.toContain("ads.example");
  });

  it("宿主不支持广告时保留能力诊断，不误提示 VIP 领取失败", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    platform.sdk.canIUse = () => false;
    const create = vi.mocked(platform.sdk.createRewardedVideoAd);
    const error = await runtime.watchVIPAd().catch(reason => reason);
    expect(error).toMatchObject({ code: "rewarded_ad_unavailable", message: "Rewarded ad capability or ad unit is unavailable" });
    expect(userMessage(error, text("vip.grantError"))).toBe(text("runtime.rewardedAdFailed"));
    expect(create).not.toHaveBeenCalled();
    expect(runtime.hasPendingAdClaim()).toBe(false);
  });

  it("缺少 VIP 入口时提示策略暂不可用，不创建广告", async () => {
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response({ ...startup(), vipOffer: undefined })), startup));
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const error = await runtime.watchVIPAd().catch(reason => reason);
    expect(error).toMatchObject({ code: "vip_offer_unavailable" });
    expect(userMessage(error, text("vip.grantError"))).toBe(text("runtime.dailyVipUnavailable"));
    expect(platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
  });

  it("另一条全屏广告未关闭时记录占用原因，关闭后允许 VIP 广告正常开始", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const other = { claimId: "other-ad-claim", offerId: "episode-offer", adUnitId: "episode-placement" };
    const active = runtime.showRewardedAd(other.adUnitId, other);
    const error = await runtime.watchVIPAd().catch(reason => reason);
    expect(error).toMatchObject({ code: "rewarded_ad_unavailable", message: "Another full-screen ad is still active" });
    expect(log).toHaveBeenCalledWith({ event: "rewarded_ad_busy", error: "Another full-screen ad is still active" });
    expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledOnce();
    platform.closeRewardedAd({ isEnded: false });
    await expect(active).resolves.toEqual({ status: "cancelled" });
    const retry = runtime.watchVIPAd();
    await vi.advanceTimersByTimeAsync(0);
    platform.closeRewardedAd({ isEnded: false });
    await expect(retry).resolves.toBeNull();
    expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([record]) => record?.event === "rewarded_ad_busy")).toHaveLength(1);
    expect(runtime.hasPendingAdClaim()).toBe(false);
  });

  it("完播后确认失败保留待领取记录，阻止下一条广告并提示奖励待确认", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const claim = vi.spyOn(runtime.api, "claimReward").mockRejectedValue(new Error("reward confirmation connection lost"));
    const pending = runtime.watchVIPAd().catch(reason => reason);
    await vi.advanceTimersByTimeAsync(0);
    platform.closeRewardedAd({ isEnded: true });
    const error = await pending;
    expect(error).toMatchObject({ code: "reward_pending_confirmation" });
    expect(userMessage(error, text("vip.grantError"))).toBe(text("runtime.rewardConfirmationPending"));
    expect(runtime.hasPendingAdClaim()).toBe(true);
    await expect(runtime.watchVIPAd()).rejects.toMatchObject({ code: "reward_pending_confirmation" });
    expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).toContain("reward confirmation connection lost");
  });
});

describe("所有环境使用同一官方运行链路", () => {
  it.each([false])("开发模式=%s，遗留模拟开关不能替换 API、登录或播放器", async (development) => {
    vi.stubEnv("DEV", development);
    vi.stubEnv("VITE_DEMO_MODE", "true");
    vi.stubEnv("VITE_PLATFORM_MODE", "mock");
    vi.stubEnv("VITE_PLAYER_MODE", "mock");
    class FixturePlayer {
      static Events = {};
      on() {}
      playNext() { return Promise.resolve(); }
      destroy() {}
    }
    const getPlayer = vi.fn(async () => FixturePlayer);
    platform.sdk.getPlayer = getPlayer;
    const runtime = createRuntime(new OfficialTikTokMinisPlayerAdapter(() => window.TTMinis));
    await runtime.bootstrap();
    expect(runtime.api).toBeInstanceOf(HttpMiniDramaApi);
    expect(platform.sdk.login).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/session"), expect.objectContaining({
      body: expect.stringContaining('"loginCode":"test-login-code"'),
    }));
    await runtime.preparePlayback?.();
    expect(getPlayer).toHaveBeenCalledWith("byteplus");
    expect(runtime.createPlaybackEngine()).toBeInstanceOf(TikTokMinisPlayerEngine);
  });

  it("官方 SDK 加载失败时拒绝登录和播放，并记录实际原因", async () => {
    delete window.TTMinis;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = createRuntime(new OfficialTikTokMinisPlayerAdapter(() => window.TTMinis));
    const login = expect(runtime.bootstrap()).rejects.toThrow("TikTok SDK script failed to load");
    const player = expect(runtime.preparePlayback?.()).rejects.toThrow("TikTok SDK script failed to load");
    document.querySelector("script[data-tiktok-sdk]")!.dispatchEvent(new Event("error"));
    await Promise.all([login, player]);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).includes("/open/"))).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: "tiktok_sdk_initialize_failed", error: "TikTok SDK script failed to load" }));
  });

  it("等待不会自动完成广告，取消后不提交奖励且允许重新观看", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    const grant = vi.spyOn(runtime.api, "claimReward");
    const settled = vi.fn();
    const pending = runtime.watchVIPAd().then((result) => { settled(result); return result; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    platform.closeRewardedAd({ isEnded: false });
    await expect(pending).resolves.toBeNull();
    expect(grant).not.toHaveBeenCalled();
    expect(runtime.hasPendingAdClaim()).toBe(false);
  });
});

describe("服务端启动配置", () => {

  it("采用服务端的广告门禁与应用品牌配置", async () => {
		vi.stubEnv("VITE_TIKTOK_APP_ID", "japanese-only");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                applicationId: "app-ja",
                tiktokAppId: "japanese-only",
                visitorId: "visitor-ja",
                identityState: "tiktok_authenticated",
                visitorToken: "visitor-ja",
                appName: "Japanese Drama",
                logoUrl: "https://cdn.example.test/japanese-drama.png",
                complianceBaseUrl: "https://legal.example.test/apps/japanese-only",
                playbackSdk: {
                  provider: "tiktok_minis",
                  channel: "byteplus",
                },
                monetization: {
                  status: "enabled",
                  strategy: "episode_reward",
                  freeEpisodeCount: 1,
                  episodeReward: {
                    unlockEpisodeCount: 1,
                    dailyRewardLimit: 0,
                  },
                  vip: {
                    enabled: true,
                    requiredAdCount: 3,
                    delaySeconds: 1,
                    title: "",
                    content: "",
                  },
                },
                vipState: {
                  active: false,
                  adCount: 0,
                  requiredCount: 1,
                  progressDate: "2026-07-15",
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const runtime = createRuntime();
    await runtime.bootstrap();

    expect(runtime.getAdExperience().monetizationPolicy).toMatchObject({
      status: "enabled",
      freeEpisodeCount: 1,
    });
    expect(runtime.getAdExperience().vipState.active).toBe(false);
    expect(runtime.getApplicationBrand()).toEqual({
      name: "Japanese Drama",
      logoUrl: "https://cdn.example.test/japanese-drama.png",
    });
    expect(runtime.getComplianceBaseURL()).toBe(
      "https://legal.example.test/apps/japanese-only",
    );
    expect(document.title).toBe("Japanese Drama");
  });

});

describe("服务端 VIP 进度", () => {
  it("仅采用每次 HTTP 结算确认的 VIP 进度，在服务端确认后生效", async () => {
    vi.useFakeTimers();
    let confirmations = 0;
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("session")) return response(startup());
      const claim = JSON.parse(String(init?.body)) as RewardClaim;
      confirmations += 1;
      return response({ claimId: claim.claimId, status: "granted", rewardType: "vip_progress", unlocked: false,
        vipState: { ...startup().vipState, adCount: confirmations, active: confirmations === 5 } });
    }), startup));
    const runtime = createRuntime();
    const claimReward = vi.spyOn(runtime.api, "claimReward");
    const listener = vi.fn();
    runtime.subscribeAdExperience(listener);

    await runtime.bootstrap();
    await runtime.refreshAdExperience();
    expect(runtime.getAdExperience().vipState.adCount).toBe(0);
    listener.mockClear();

    await completeVIPAd(runtime);
    await completeVIPAd(runtime);
    const releaseClaim = await completeVIPAd(runtime);

    expect(releaseClaim?.rewardType).toBe("vip_progress");
    expect(claimReward).toHaveBeenCalledWith(expect.objectContaining({
      offerId: "vip-offer",
      adUnitId: "vip-placement",
    }));
    expect(runtime.getAdExperience()).toMatchObject({
      vipState: {
        active: false,
        adCount: 3,
        requiredCount: 5,
      },
    });

    await completeVIPAd(runtime);
    const vipClaim = await completeVIPAd(runtime);
    expect(vipClaim?.rewardType).toBe("vip_progress");
    expect(runtime.getAdExperience().vipState).toMatchObject({
      active: true,
      adCount: 5,
      requiredCount: 5,
    });
    // 启动的配置/身份/状态分别通知；之后五次结算只应用权威状态，不重新登录。
    expect(listener).toHaveBeenCalledTimes(5);
    expect(platform.sdk.login).toHaveBeenCalledOnce();
  });
});

describe("启动路由", () => {
  it("只采用服务端确认的启动目标，不根据查询参数生成演示剧目", async () => {
    window.history.replaceState(
      {},
      "",
      "/?dramaId=drama-1&episodeId=drama-1-episode-2",
    );
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async input => {
      if (String(input).endsWith("/play/entry")) return response(entryResponse("drama-1", "drama-1-episode-2"));
      return response(startup());
    }), startup));
    const runtime = createRuntime();

    await runtime.bootstrap();

    expect(runtime.getLaunchTarget()).toEqual({
      dramaId: "drama-1",
      episodeId: "drama-1-episode-2",
    });
    expect(runtime.getVisitorID()).toBe("visitor");
  });
});

it("公开首页不等待 SDK，预取与挂载去重，登录和播放器必须等官方初始化", async () => {
  delete window.TTMinis;
  let finishInit!: () => void;
  window.__TIKTOK_MINIS_INITIALIZE__ = () => new Promise<void>(resolve => { finishInit = resolve; });
  const ctor = vi.fn(async () => class {} as never);
  const runtime = createRuntime({ getConstructor: ctor });
  const api = vi.mocked(fetch);
  const onSections = vi.fn();
  api.mockImplementation(async input => {
    const url = String(input);
    if (url.includes("/open/home/carousel") || url.includes("/open/home/hot") || url.includes("/open/home/ranking-categories")) return response([]);
    if (url.includes("/open/catalog")) return response({ tiktokAppId: "test-app", dramas: [] });
    if (url.endsWith("/me/vip")) return response(startup().vipState);
    return response(startup());
  });
  try {
    const prefetch = runtime.prefetchHome!(onSections);
    const login = runtime.bootstrap();
    const player = runtime.preparePlayback!();
    await Promise.all([prefetch, runtime.loadHomeSections!(), runtime.loadPublicCatalog!({ limit: 20 })]);
    expect(api.mock.calls.filter(([url]) => !String(url).includes("/open/app-config"))).toHaveLength(4);
    expect(runtime.getCachedHomeSections!()).toEqual({ carousel: [], hot: [], rankings: [] });
    expect(onSections).toHaveBeenCalledTimes(2);
    expect(onSections).toHaveBeenLastCalledWith({ carousel: [], hot: [], rankings: [] });
    expect(platform.sdk.login).not.toHaveBeenCalled();
    expect(ctor).not.toHaveBeenCalled();
    window.TTMinis = platform.sdk;
    document.querySelector("script[data-tiktok-sdk]")!.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(platform.sdk.login).not.toHaveBeenCalled();
    finishInit();
    await Promise.all([login, player]);
    expect(platform.sdk.login).toHaveBeenCalledOnce();
    expect(ctor).toHaveBeenCalledOnce();
    expect(api.mock.calls.filter(([input]) => String(input).includes("/session"))).toHaveLength(1);
  } finally {
    delete window.__TIKTOK_MINIS_INITIALIZE__;
    document.querySelectorAll("script[data-tiktok-sdk]").forEach(script => script.remove());
  }
});

it("直连应用共用 TikTok 身份，初始化与基础版预加载都不调用官方 getPlayer", async () => {
  const { DirectVePlayerAdapter } = await import("../player/vePlayerEngine");
  const directConfig = { provider: "byteplus_web" as const, channel: "byteplus" as const, capabilities: { mediaPreload: false } };
  vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response({ ...startup(), playbackSdk: directConfig })), () => ({ ...startup(), playbackSdk: directConfig })));
  const getPlayer = vi.fn(); window.TTMinis = { ...platform.sdk, getPlayer };
  const load = vi.spyOn(DirectVePlayerAdapter.prototype, "getConstructor").mockResolvedValue(class {} as never);
  const runtime = createRuntime(); await runtime.bootstrap(); await runtime.preparePlayback?.();
  await runtime.preloadMedia?.([], 1);
  expect(platform.sdk.login).toHaveBeenCalled(); expect(getPlayer).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledOnce();
  expect(runtime.createPlaybackEngine()).not.toBeInstanceOf(TikTokMinisPlayerEngine);
});

it.each((["tiktok_minis", "byteplus_web"] as const).flatMap(provider =>
  (["session", "vip", "launch"] as const).map(waiting => ({ provider, waiting }))))(
  "$provider 的准备遵守服务端通道与身份门禁，落地与 VIP 查询不阻塞构造器：$waiting",
  async ({ provider, waiting }) => {
    const { DirectVePlayerAdapter } = await import("../player/vePlayerEngine");
    const direct = vi.spyOn(DirectVePlayerAdapter.prototype, "getConstructor").mockResolvedValue(class {} as never);
    const official = vi.fn(async () => class {} as never);
    const configured = { ...startup(), playbackSdk: provider === "byteplus_web"
      ? { provider, channel: "byteplus" as const, capabilities: { mediaPreload: false } }
      : { provider, channel: "byteplus" as const } };
    let finishConfig!: (value: Response) => void;
    const configPending = new Promise<Response>(resolve => { finishConfig = resolve; });
    let finishDependency!: (value: Response) => void;
    const dependencyPending = new Promise<Response>(resolve => { finishDependency = resolve; });
    const launch = entryResponse("201", "301");
    const paths: Record<typeof waiting, string> = { session: "/session", vip: "/me/vip", launch: "/play/entry" };
    const dependency = waiting === "vip" ? startup().vipState : waiting === "launch" ? launch : startup();
    const fetcher = vi.fn<typeof fetch>(async input => {
      const path = String(input).split("?")[0];
      if (path.endsWith("/open/app-config")) return configPending;
      if (path.endsWith(paths[waiting])) return dependencyPending;
      if (path.endsWith("/session")) return response(startup());
      if (path.endsWith("/me/vip")) return response(startup().vipState);
      if (path.endsWith("/play/entry")) return response(launch);
      return response({ accepted: true });
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", waiting === "vip" ? "/" : "/?dramaId=201&episodeId=301");
    const runtime = createRuntime({ getConstructor: official });
    const initialized = vi.fn();
    const boot = runtime.bootstrap().then(initialized);
    const prepared = vi.fn();
    const preparation = runtime.preparePlayback!().then(prepared);
    try {
      await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("/open/app-config"))).toBe(true));
      expect(direct).not.toHaveBeenCalled();
      expect(official).not.toHaveBeenCalled();
      finishConfig(response(configured));
      await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).split("?")[0].endsWith(paths[waiting]))).toBe(true));
      if (provider === "byteplus_web" || waiting !== "session") {
        await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce());
      } else {
        expect(prepared).not.toHaveBeenCalled();
        expect(official).not.toHaveBeenCalled();
      }
      expect(provider === "byteplus_web" ? official : direct).not.toHaveBeenCalled();
      if (waiting === "vip") {
        await vi.waitFor(() => expect(initialized).toHaveBeenCalledOnce());
      } else {
        expect(initialized).not.toHaveBeenCalled();
        expect(runtime.getLaunchTarget()).toBeUndefined();
      }
      expect(fetcher.mock.calls.some(([url]) => String(url).includes("/play/resolve"))).toBe(false);
    } finally {
      finishConfig(response(configured));
      finishDependency(response(dependency));
      await Promise.all([boot, preparation]);
    }
    expect(provider === "byteplus_web" ? direct : official).toHaveBeenCalledOnce();
    expect(provider === "byteplus_web" ? official : direct).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/open/app-config"))).toHaveLength(1);
  },
);

it("直连基础版必须明确关闭高级预加载，损坏配置不允许创建播放器但保留登录态", async () => {
  for (const capabilities of [undefined, {}, { mediaPreload: true }]) {
    vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response({
      ...startup(),
      playbackSdk: { provider: "byteplus_web", channel: "byteplus", capabilities },
    })), () => ({ ...startup(), playbackSdk: { provider: "byteplus_web", channel: "byteplus", capabilities } } as BootstrapResult)));
    const runtime = createRuntime();
    await expect(runtime.bootstrap()).rejects.toThrow();
    await vi.waitFor(() => expect(runtime.getVisitorID()).toBe("visitor"));
    expect(() => runtime.createPlaybackEngine()).toThrow();
  }
});

it("同一应用重新启动选择最新播放器，保留观众本地库和身份", async () => {
  const { DirectVePlayerAdapter } = await import("../player/vePlayerEngine");
  const directConfig = { provider: "byteplus_web" as const, channel: "byteplus" as const, capabilities: { mediaPreload: false } };
  let selected: BootstrapResult["playbackSdk"] = startup().playbackSdk;
  const fetcher = vi.fn<typeof fetch>(async () => response(startup()));
  vi.stubGlobal("fetch", splitConsumerFetch(fetcher, () => ({ ...startup(), playbackSdk: selected })));
  const load = vi.spyOn(DirectVePlayerAdapter.prototype, "getConstructor").mockResolvedValue(class {} as never);
  const official = createRuntime();
  await official.bootstrap();
  expect(official.createPlaybackEngine()).toBeInstanceOf(TikTokMinisPlayerEngine);
  official.localLibrary.recordProgress({ dramaId: "201", episodeId: "301", episodeNumber: 1, progressSeconds: 42, durationSeconds: 90 });
  official.localLibrary.setFollow("201", true);
  selected = directConfig;
  const direct = createRuntime();
  await direct.bootstrap();
  await direct.preparePlayback?.();
  expect(direct.createPlaybackEngine()).not.toBeInstanceOf(TikTokMinisPlayerEngine);
  expect(direct.getVisitorID()).toBe(official.getVisitorID());
  expect(direct.localLibrary.history()).toEqual(official.localLibrary.history());
  expect(direct.localLibrary.isFollowing("201")).toBe(true);
  selected = startup().playbackSdk;
  const restored = createRuntime();
  await restored.bootstrap();
  expect(restored.createPlaybackEngine()).toBeInstanceOf(TikTokMinisPlayerEngine);
  expect(restored.getVisitorID()).toBe(official.getVisitorID());
  expect(restored.localLibrary.history()[0]).toMatchObject({ episodeId: "301", progressSeconds: 42 });
  expect(load).toHaveBeenCalledOnce();
});

it("入剧目录未返回时立即展示，广告取消不生成奖励", async () => {
  vi.useFakeTimers();
  vi.spyOn(HttpMiniDramaApi.prototype, "drama").mockImplementation(() => new Promise(() => {}));
  const runtime = createRuntime();
  await runtime.bootstrap();
  const claim = { claimId: "slow-context-claim", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" };
  const pending = runtime.showRewardedAd(claim.adUnitId, claim);
  // 查询尚未返回，也不推进任何定时器；广告必须立即调用。
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledOnce();
  platform.closeRewardedAd({ isEnded: false });
  await expect(pending).resolves.toEqual({ status: "cancelled" });
  expect(runtime.hasPendingAdClaim()).toBe(false);
  expect(runtime.isFullscreenAdActive?.()).toBe(false);
});

it("慢目录不阻塞广告或取消结算，展示回传等同一剧目的剧名补齐", async () => {
  vi.stubEnv("VITE_TIKTOK_CLIENT_KEY", "test-client-key");
  vi.stubGlobal("fetch", splitConsumerFetch(vi.fn<typeof fetch>(async () => response({ ...startup(), tiktokOpenId: "test-open-id" })), startup));
  const originalCanIUse = platform.sdk.canIUse!;
  platform.sdk.canIUse = capability => capability === "reportEvent" || originalCanIUse(capability);
  const reportEvent = vi.fn<NonNullable<typeof platform.sdk.reportEvent>>(options => options.callback({ isSuccess: true }));
  platform.sdk.reportEvent = reportEvent;
  let resolveDrama!: (detail: Awaited<ReturnType<HttpMiniDramaApi["drama"]>>) => void;
  vi.spyOn(HttpMiniDramaApi.prototype, "drama").mockImplementation(() => new Promise(resolve => { resolveDrama = resolve; }));
  const runtime = createRuntime();
  await runtime.bootstrap();
  const claim = { claimId: "late-title-claim", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" };
  const pending = runtime.showRewardedAd(claim.adUnitId, claim);
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledOnce();
  expect(reportEvent).not.toHaveBeenCalled();
  await Promise.resolve(); // 仅等待 show Promise 确认展示，不等待目录或定时器。
  platform.closeRewardedAd({ isEnded: false });
  await expect(pending).resolves.toEqual({ status: "cancelled" });
  expect(runtime.hasPendingAdClaim()).toBe(false);
  expect(runtime.isFullscreenAdActive?.()).toBe(false);
  resolveDrama({ id: "201", title: "Late catalogue title", episodeCount: 2, episodes: [] } as unknown as Awaited<ReturnType<HttpMiniDramaApi["drama"]>>);
  await vi.advanceTimersByTimeAsync(0);
  expect(reportEvent).toHaveBeenCalledOnce();
  expect(reportEvent.mock.calls[0][0]).toMatchObject({ eventName: "minis_ad_show", params: {
    minis_drama_id: "201", minis_drama_name: "Late catalogue title", if_first_time: 1, if_last_ep: null,
  } });
  expect(reportEvent.mock.calls[0][0].params).not.toHaveProperty("episode_number");
});

it("VIP Offer 等待期间后台往返会作废原意图，旧响应不调用广告", async () => {
  const runtime = createRuntime();
  await runtime.bootstrap();
    await runtime.refreshAdExperience();
  let finish!: (value: NonNullable<BootstrapResult["vipOffer"]>) => void;
  vi.spyOn(HttpMiniDramaApi.prototype, "vipOffer").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = expect(runtime.watchVIPAd()).rejects.toMatchObject({ code: "ad_foreground_required" });
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(0); // 等待正常权益重查，原展示意图仍保持旧版本。
  finish(startup().vipOffer!);
  await pending;
  expect(platform.sdk.createRewardedVideoAd).not.toHaveBeenCalled();
  expect(runtime.hasPendingAdClaim()).toBe(false);
});
