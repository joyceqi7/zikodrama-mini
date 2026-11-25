import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { AccessOffer, AdExperience, DramaDetail, EntryAdStatus, PlaybackIdentity, PlayResolveResult } from "../domain/types";
import { ApiError } from "../api/httpMiniDramaApi";
import { ServerClock } from "../domain/serverTime";
import type { PlaybackCallbacks, PlaybackEngine } from "../player/playbackEngine";
import { showRewardedAd } from "../platform/tiktok/rewardedAd";
import type { RewardedAdCloseResult, TikTokMinisSDK } from "../platform/tiktok/types";
import { RuntimeContext } from "../runtime/RuntimeContext";
import type { Runtime, EntitlementChange } from "../runtime/runtime";
import { text } from "../copy";
import { PlayerPage } from "./PlayerPage";

const drama: DramaDetail = {
  id: "1", firstEpisodeId: "1", title: "自动解锁测试", description: "", coverUrl: "cover.jpg", tags: [], status: "completed", episodeCount: 2,
  episodes: [1, 2].map(number => ({ id: String(number), dramaId: "1", number, title: `Episode ${number}`, description: "", posterUrl: `poster-${number}.jpg`, durationSeconds: 60, accessMode: "rewarded" as const })),
};
const offer: AccessOffer = { offerId: "episode-offer", adUnitId: "episode-ad", kind: "rewarded_episode" };
const experience: AdExperience = {
  vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "2026-09-16" },
  monetizationPolicy: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 0, episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 }, vip: { enabled: false, requiredAdCount: 1, title: "", content: "" } },
};

function setup(options: { automatic?: boolean; promptOnIncomplete?: boolean; incompleteAdCountdownSeconds?: number; incompleteAdDisplayCountdownSeconds?: number; episodes?: number; notifyEntitlement?: boolean; playbackInClaim?: boolean; stalePlaybackInClaim?: boolean; directoryInClaim?: boolean; provider?: PlaybackIdentity["provider"] } = {}) {
  let revision = 0;
  const entitlementListeners = new Set<(change: EntitlementChange) => void>();
  const content: DramaDetail = { ...drama, episodeCount: options.episodes ?? 2,
    episodes: Array.from({ length: options.episodes ?? 2 }, (_, index) => ({ ...drama.episodes[0], id: String(index + 1), number: index + 1, posterUrl: `poster-${index + 1}.jpg` })) };
  const identity = (episode: DramaDetail["episodes"][number], stale = false): PlaybackIdentity => {
    const clock = new ServerClock();
    const source = clock.bind<PlaybackIdentity>({
      channel: "byteplus", provider: options.provider, vid: `vid-${episode.id}`, posterUrl: episode.posterUrl,
      title: episode.title, episodeNumber: episode.number, durationSeconds: 60,
      ...(options.provider === "byteplus_web" ? { playAuthToken: "test-auth", expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { albumId: "1", episodeId: episode.id }),
    }, new Date().toISOString(), performance.now(), 0, 0);
    if (stale) clock.invalidate();
    return source;
  };
  const episodeOffer: AccessOffer = { ...offer, ...(options.automatic ? { ruleCode: "episode", autoUnlock: { enabled: true, countdownSeconds: 5 } } : {}), ...(options.promptOnIncomplete ? { promptOnIncomplete: true } : {}), ...(options.incompleteAdCountdownSeconds ? { incompleteAdCountdownSeconds: options.incompleteAdCountdownSeconds } : {}), ...(options.incompleteAdDisplayCountdownSeconds ? { incompleteAdDisplayCountdownSeconds: options.incompleteAdDisplayCountdownSeconds } : {}) };
  let close: ((result: RewardedAdCloseResult) => void) | undefined;
  let callbacks: PlaybackCallbacks = {};
  const sdk = { canIUse: () => true, createRewardedVideoAd: vi.fn(() => ({
    show: vi.fn(async () => {}), onClose: (callback: typeof close) => { close = callback; }, onError: vi.fn(), offClose: vi.fn(), offError: vi.fn(),
  })) } as unknown as TikTokMinisSDK;
  const unlocked = new Set<string>();
  let playerPaused = false;
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, source, nextCallbacks) => { callbacks = nextCallbacks ?? {}; playerPaused = source.autoplay === false; if (!playerPaused) callbacks.onPlay?.(); return true; }),
    switchSource: vi.fn(async source => { playerPaused = source.autoplay === false; }), play: vi.fn(async () => { playerPaused = false; callbacks.onPlay?.(); }), pause: vi.fn(() => { playerPaused = true; }), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: playerPaused, ended: false }),
  };
  const resolvePlay = vi.fn(async (_dramaId: string, id: string): Promise<PlayResolveResult> => {
    const episode = content.episodes.find(item => item.id === id)!;
    return unlocked.has(id)
      ? { status: "playable", drama: content, episode, playback: identity(episode) }
      : { status: "access_required", drama: content, episode, offer: episodeOffer };
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })), drama: vi.fn(async () => ({ ...content, episodes: content.episodes.map(episode => unlocked.has(episode.id) ? { ...episode, accessMode: "unlocked" as const } : episode) })), resolvePlay },
    getAdExperience: () => experience, subscribeAdExperience: () => () => {},
    hasPendingAdClaim: () => false,
    ...(options.notifyEntitlement ? {
      getVisitorID: () => "A", getApplicationID: () => "app", getEntitlementRevision: () => revision,
      subscribeEntitlements: (listener: (change: EntitlementChange) => void) => { entitlementListeners.add(listener); return () => entitlementListeners.delete(listener); },
    } : {}),
    createPlaybackEngine: () => engine,
    preloadMedia: vi.fn(async () => {}),
    clearMediaPreload: vi.fn(),
    showRewardedAd: vi.fn(async (adUnitId: string) => showRewardedAd(sdk, adUnitId)),
    claimReward: vi.fn(async (claim) => {
      unlocked.add(claim.episodeId!);
      const unlockedEpisode = content.episodes.find(item => item.id === claim.episodeId)!;
      const playback = options.playbackInClaim ? {
        status: "playable" as const, drama: content, episode: unlockedEpisode,
        playback: identity(unlockedEpisode, options.stalePlaybackInClaim),
      } : undefined;
      const directory = options.directoryInClaim ? { ...content, episodes: content.episodes.map(episode => unlocked.has(episode.id)
        ? { ...episode, accessMode: "unlocked" as const } : episode) } : undefined;
      if (options.notifyEntitlement) {
        revision += 1;
        entitlementListeners.forEach(listener => listener({ revision, applicationId: "app", visitorId: "A", identityGeneration: 1,
          rewardType: "episode_unlock", dramaId: claim.dramaId, episodeId: claim.episodeId, playback, drama: directory }));
      }
      const next = content.episodes.find(item => item.number > Number(claim.episodeId) && !unlocked.has(item.id));
      return { ...claim, status: "granted", unlocked: true, rewardType: "episode_unlock",
        playback, drama: directory,
        nextAd: options.automatic && next ? { dramaId: content.id, episodeId: next.id, episodeNumber: next.number,
          unlockedCount: unlocked.size, totalCount: content.episodes.length, offer: episodeOffer } : null };
    }),
  } as unknown as Runtime;
  const open = () => render(<StrictMode><RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/1/1"]}>
    <Link to="/watch/1/1">测试切至第一集</Link><Link to="/watch/1/2">测试切至第二集</Link>
    <Link to="/watch/1/3">测试切至第三集</Link>
    <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
  </MemoryRouter></RuntimeContext.Provider></StrictMode>);
  return {
    runtime, engine, sdk, resolvePlay, unlocked, open,
    finish: (isEnded: boolean) => act(async () => { close?.({ isEnded }); }),
    firstFrame: (vid: string) => act(() => callbacks.onFirstFrame?.(vid)),
  };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** gateStatus 用服务端时钟构造已达标/跨日未达标状态，避免测试依赖手机日期。 */
function gateStatus(scope: EntryAdStatus["scope"] = "user", countBy: EntryAdStatus["countBy"] = "completed", count = 2): EntryAdStatus {
  return new ServerClock().bind({ enabled: true, scope, countBy, shownCount: count, completedCount: count, requiredCount: 2,
    progressDate: "2026-10-24", validUntil: new Date(Date.now() + 60_000).toISOString(),
    offer: { offerId: "entry", adUnitId: "entry-ad", kind: "rewarded_entry" },
  } satisfies EntryAdStatus, new Date().toISOString(), performance.now(), 0, 0);
}

it.each([
  ["tiktok_minis", "user", "shown"], ["tiktok_minis", "user", "completed"],
  ["tiktok_minis", "user_drama", "shown"], ["tiktok_minis", "user_drama", "completed"],
  ["byteplus_web", "user", "shown"], ["byteplus_web", "user", "completed"],
  ["byteplus_web", "user_drama", "shown"], ["byteplus_web", "user_drama", "completed"],
] as const)("%s 入剧 %s/%s 达标后回前台保留连续解锁弹窗，重查期间冻结倒计时", async (provider, scope, countBy) => {
  const h = setup({ provider, automatic: true, episodes: 3, notifyEntitlement: true, playbackInClaim: true });
  let confirm!: (status: EntryAdStatus) => void;
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementation(async () => gateStatus(scope, countBy));
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  await h.finish(true);
  const dialog = screen.getByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  expect(h.engine.mount).toHaveBeenCalledOnce();
  const initialQueries = vi.mocked(h.runtime.api.entryAdStatus).mock.calls.length;
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText("4s")).toBeInTheDocument();
  fireEvent(window, new Event("pagehide"));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  fireEvent(window, new Event("pageshow"));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(dialog).toBeInTheDocument();
  expect(dialog).not.toBeVisible();
  expect(h.engine.destroy).not.toHaveBeenCalled();
  expect(h.engine.play).not.toHaveBeenCalled();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  await act(async () => confirm(gateStatus(scope, countBy)));
  expect(screen.getByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBe(dialog);
  expect(screen.getByText("4s")).toBeInTheDocument();
  for (let second = 0; second < 3; second++) await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2);
  expect(h.runtime.api.entryAdStatus).toHaveBeenCalledTimes(initialQueries + 1);
  expect(h.engine.mount).toHaveBeenCalledOnce();
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 回前台查询失败保持阻塞，重试后恢复原弹窗而不重复领奖", async provider => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = setup({ provider, automatic: true, episodes: 3, playbackInClaim: true });
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementation(async () => gateStatus());
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  const dialog = await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  vi.mocked(h.runtime.api.entryAdStatus).mockRejectedValueOnce(new Error("test gate unavailable"));
  fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
  await screen.findByRole("button", { name: "Retry" });
  expect(dialog).not.toBeVisible();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  expect(h.engine.play).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith({ event: "entry_ad_status_failed", error: "test gate unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(dialog).toBeVisible());
  expect(screen.getByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBe(dialog);
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  expect(h.engine.destroy).not.toHaveBeenCalled();
});

it.each([
  ["tiktok_minis", "入剧先返回"], ["tiktok_minis", "播放先返回"],
  ["byteplus_web", "入剧先返回"], ["byteplus_web", "播放先返回"],
] as const)("%s 回前台 %s，必须两项验权均通过才恢复原播放器", async (provider, order) => {
  const h = setup({ provider });
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementation(async () => gateStatus());
  h.unlocked.add("1"); h.open();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  let confirmEntry!: (status: EntryAdStatus) => void;
  let confirmPlayback!: (result: PlayResolveResult) => void;
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementationOnce(() => new Promise(resolve => { confirmEntry = resolve; }));
  const initialResolve = h.resolvePlay.getMockImplementation()!;
  h.resolvePlay.mockImplementation((id, episode) => episode === "1"
    ? new Promise(resolve => { confirmPlayback = resolve; }) : initialResolve(id, episode));
  fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
  expect(h.engine.snapshot().paused).toBe(true);
  await act(async () => {
    if (order === "入剧先返回") confirmEntry(gateStatus());
    else confirmPlayback(await initialResolve("1", "1"));
  });
  expect(h.engine.play).not.toHaveBeenCalled();
  await act(async () => {
    if (order === "入剧先返回") confirmPlayback(await initialResolve("1", "1"));
    else confirmEntry(gateStatus());
  });
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  expect(h.engine.mount).toHaveBeenCalledOnce();
  expect(h.engine.destroy).not.toHaveBeenCalled();
  expect(h.runtime.showRewardedAd).not.toHaveBeenCalled();
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 跨日未达标先完成入剧广告，再恢复原连续解锁提示", async provider => {
  const h = setup({ provider, automatic: true, episodes: 3, playbackInClaim: true });
  const nextDay = { ...gateStatus("user", "completed", 0), progressDate: "2026-10-25", requiredCount: 1 };
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementation(async () => gateStatus());
  let closeEntry!: () => void;
  h.runtime.showEntryAd = vi.fn(() => new Promise<{ status: "completed" }>(resolve => { closeEntry = () => resolve({ status: "completed" }); }));
  const claimEpisode = h.runtime.claimReward;
  h.runtime.claimReward = vi.fn(async input => input.episodeId ? claimEpisode(input) : {
    ...input, status: "granted", rewardType: "entry_progress", unlocked: false,
    entryAdStatus: { ...nextDay, completedCount: 1 },
  });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  const dialog = await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  vi.mocked(h.runtime.api.entryAdStatus).mockResolvedValue(nextDay);
  fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
  await waitFor(() => expect(h.runtime.showEntryAd).toHaveBeenCalledOnce());
  expect(dialog).not.toBeVisible();
  expect(h.engine.play).not.toHaveBeenCalled();
  await act(async () => closeEntry());
  expect(dialog).toBeVisible();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  expect(h.runtime.claimReward).toHaveBeenCalledTimes(2);
  expect(vi.mocked(h.runtime.claimReward).mock.calls.filter(([claim]) => !!claim.episodeId)).toHaveLength(1);
  expect(h.engine.destroy).not.toHaveBeenCalled();
});

it.each(["tiktok_minis", "byteplus_web"] as const)("%s 门禁重查期间切到锁定集，重新放行后才自动拉起该集广告", async provider => {
  const h = setup({ provider });
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementation(async () => gateStatus());
  h.unlocked.add("1"); h.open();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  let confirm!: (status: EntryAdStatus) => void;
  vi.mocked(h.runtime.api.entryAdStatus).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
  fireEvent.click(screen.getByText("测试切至第二集"));
  await act(async () => { await Promise.resolve(); });
  expect(h.runtime.showRewardedAd).not.toHaveBeenCalled();
  await act(async () => confirm(gateStatus()));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  expect(vi.mocked(h.runtime.showRewardedAd).mock.calls[0][1]).toMatchObject({ dramaId: "1", episodeId: "2" });
});

it("VIP 强制入剧的状态重查及过期重新领取不卸载连续解锁上下文", async () => {
  const h = setup({ automatic: true, episodes: 3, playbackInClaim: true });
  let current: AdExperience = { ...experience, vipState: { ...experience.vipState, active: true },
    monetizationPolicy: { ...experience.monetizationPolicy, vip: { ...experience.monetizationPolicy.vip, enabled: true, requireBeforePlayback: true } } };
  const listeners = new Set<() => void>();
  h.runtime.getAdExperience = () => current;
  h.runtime.subscribeAdExperience = callback => { listeners.add(callback); return () => listeners.delete(callback); };
  const install = (next: AdExperience) => act(() => { current = next; listeners.forEach(callback => callback()); });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  const dialog = await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  install({ ...current, refreshRequired: true });
  expect(dialog).not.toBeVisible();
  expect(h.engine.destroy).not.toHaveBeenCalled();
  install({ ...current, refreshRequired: false });
  expect(dialog).toBeVisible();
  // 查询确认已到期时必须继续封闭，不能因保留子树而绕过强制 VIP 门禁。
  install({ ...current, vipState: { ...current.vipState, active: false, adCount: 1 } });
  expect(dialog).not.toBeVisible();
  h.runtime.claimVIP = vi.fn(async () => { install({ ...current, vipState: { ...current.vipState, active: true } }); return current.vipState; });
  fireEvent.click(await screen.findByRole("button", { name: "Claim today's VIP" }));
  await waitFor(() => expect(dialog).toBeVisible());
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  expect(h.engine.destroy).not.toHaveBeenCalled();
});

it("批量解锁快速恢复会清除相邻集已预取的锁定缓存", async () => {
  const h = setup({ episodes: 3, notifyEntitlement: true, playbackInClaim: true });
  h.unlocked.add("1"); h.open();
  await waitFor(() => expect(h.resolvePlay).toHaveBeenCalledWith("1", "3"));
  fireEvent.click(screen.getByText("测试切至第二集"));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  h.unlocked.add("3");
  await h.finish(true);
  fireEvent.click(screen.getByText("测试切至第三集"));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "3" })));
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
});

it("未看完广告后结束本次解锁，不弹窗或自动重开，用户可手动重试", async () => {
  const h = setup(); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  await h.finish(false);
  expect(h.runtime.claimReward).not.toHaveBeenCalled();
  expect(h.engine.mount).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const retryButton = screen.getByTestId("locked-ad-retry");
  expect(retryButton).toHaveAccessibleName(text("player.watchToUnlock"));
  expect(retryButton.closest("main")).toHaveClass("is-locked-fallback");
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();

  vi.useRealTimers();
  fireEvent.click(retryButton);
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  await h.finish(false);
  expect(h.runtime.claimReward).not.toHaveBeenCalled();
});

it("开启强弹后仅在广告未看完时提示，用户点击后重新观看并完成领奖", async () => {
  const h = setup({ promptOnIncomplete: true }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(false);
  expect(await screen.findByRole("dialog", { name: text("player.resumeUnlockTitle") })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /not now|close/i })).not.toBeInTheDocument();
  expect(h.runtime.claimReward).not.toHaveBeenCalled();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: text("player.resumeUnlockContinue") }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  await h.finish(true);
  await waitFor(() => expect(h.runtime.claimReward).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog", { name: text("player.resumeUnlockTitle") })).not.toBeInTheDocument();
});

it("强弹不可通过遮罩或 Escape 关闭，显示五秒但实际三秒后自动重新拉起广告", async () => {
  const h = setup({ promptOnIncomplete: true, incompleteAdCountdownSeconds: 3, incompleteAdDisplayCountdownSeconds: 5 }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  await h.finish(false);
  const dialog = screen.getByRole("dialog", { name: text("player.resumeUnlockTitle") });
  expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds: 5 }))).toBeInTheDocument();
  fireEvent.click(dialog.parentElement!);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(dialog).toBeInTheDocument();
  for (let second = 0; second < 2; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  expect(h.runtime.claimReward).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog", { name: text("player.resumeUnlockTitle") })).not.toBeInTheDocument();
});

it("新 Mini 收到旧 Offer 时沿用实际倒计时显示并按原时间重看", async () => {
  const h = setup({ promptOnIncomplete: true, incompleteAdCountdownSeconds: 3 }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  await h.finish(false);
  expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds: 3 }))).toBeInTheDocument();
  for (const seconds of [2, 1]) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds }))).toBeInTheDocument();
    expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2);
  expect(h.runtime.claimReward).not.toHaveBeenCalled();
});

it("连续解锁的下一条广告未看完时也按该规则显示续看弹窗", async () => {
  const h = setup({ automatic: true, promptOnIncomplete: true, incompleteAdCountdownSeconds: 1, incompleteAdDisplayCountdownSeconds: 5, episodes: 3 }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockContinue") }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  vi.useFakeTimers();
  await h.finish(false);
  expect(screen.getByRole("dialog", { name: text("player.resumeUnlockTitle") })).toBeInTheDocument();
  expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds: 5 }))).toBeInTheDocument();
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 3 }) })).toBeInTheDocument();
  expect(h.runtime.claimReward).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
});

it.each([false, true])("权益订阅=%s 时直接消费领奖响应的当前集授权，不重复请求播放解析", async notifyEntitlement => {
  const h = setup({ notifyEntitlement, playbackInClaim: true }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(h.resolvePlay.mock.calls.filter((call) => call[1] === "1")).toHaveLength(1);
});

it.each([false, true])("权益订阅=%s 时失效的直连领奖许可只补取一次播放授权，保留目录和连续解锁", async notifyEntitlement => {
  const h = setup({ provider: "byteplus_web", automatic: true, episodes: 3, notifyEntitlement,
    playbackInClaim: true, stalePlaybackInClaim: true, directoryInClaim: true });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  const detailReads = vi.mocked(h.runtime.api.drama).mock.calls.length;
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBeInTheDocument();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(h.resolvePlay.mock.calls.filter(call => call[1] === "1")).toHaveLength(2);
  expect(h.runtime.api.drama).toHaveBeenCalledTimes(detailReads);
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
});

it.each([false, true])("权益订阅=%s 时授权恢复失败不撤销奖励、目录和下一集提示，重试不再看广告", async notifyEntitlement => {
  const h = setup({ provider: "byteplus_web", automatic: true, episodes: 3, notifyEntitlement, directoryInClaim: true });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  const detailReads = vi.mocked(h.runtime.api.drama).mock.calls.length;
  const originalResolve = h.resolvePlay.getMockImplementation()!;
  h.resolvePlay.mockRejectedValue(new ApiError("authorization unconfirmed", 502, "invalid_response"));
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(text("player.playbackError"));
  expect(screen.queryByTestId("locked-ad-retry")).not.toBeInTheDocument();
  expect(h.engine.mount).not.toHaveBeenCalled();
  expect(h.runtime.api.drama).toHaveBeenCalledTimes(detailReads);
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") })); });
  h.resolvePlay.mockImplementation(originalResolve);
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
});

it("许可校验后、页面收到领奖结果前切换前后台，不复用旧代次的已完成恢复", async () => {
  const h = setup({ provider: "byteplus_web", automatic: true, episodes: 3, notifyEntitlement: true,
    playbackInClaim: true, directoryInClaim: true });
  const originalClaim = vi.mocked(h.runtime.claimReward).getMockImplementation()!;
  let finishClaim!: () => void;
  const pending = new Promise<void>(resolve => { finishClaim = resolve; });
  let authorization: PlaybackIdentity | undefined;
  vi.mocked(h.runtime.claimReward).mockImplementation(async input => {
    const result = await originalClaim(input);
    authorization = result.playback?.status === "playable" ? result.playback.playback : undefined;
    await pending;
    return result;
  });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  await act(async () => {
    authorization!.serverDeadline!.context.value += 1;
    fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
    finishClaim(); await pending;
  });
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBeInTheDocument();
  await waitFor(() => expect(h.resolvePlay.mock.calls.filter(call => call[1] === "1")).toHaveLength(2));
  expect(h.engine.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  expect(h.runtime.claimReward).toHaveBeenCalledOnce();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
});

it("当前授权通知先到时独立准备，不等待领奖返回或连续解锁弹窗", async () => {
  const h = setup({ notifyEntitlement: true, playbackInClaim: true });
  const claimReward = vi.mocked(h.runtime.claimReward).getMockImplementation()!;
  let finishClaim!: () => void;
  const gate = new Promise<void>(resolve => { finishClaim = resolve; });
  vi.mocked(h.runtime.claimReward).mockImplementation(async input => {
    const claim = await claimReward(input);
    await gate;
    return claim;
  });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(vi.mocked(h.engine.mount).mock.calls[0][1]).toMatchObject({ autoplay: false });
  expect(h.engine.play).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => { finishClaim(); await gate; });
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  expect(h.engine.mount).toHaveBeenCalledOnce();
});

it("连续解锁弹窗按服务端配置倒计时五秒后自动观看下一条广告", async () => {
  const h = setup({ automatic: true, episodes: 3 }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  await h.finish(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toHaveClass("auto-unlock-chain-dialog");
  expect(screen.getByText(text("player.autoUnlockContent"))).toBeInTheDocument();
  expect(screen.getByText(text("player.autoUnlockProgress", { unlocked: 1, total: 3 }))).toBeInTheDocument();
  expect(screen.getByRole("button", { name: text("player.autoUnlockCancel") })).toBeInTheDocument();
  expect(screen.getByText("5s")).toBeInTheDocument();
  expect(h.engine.mount).toHaveBeenCalledOnce();
  expect(h.engine.play).not.toHaveBeenCalled();
  expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  for (let second = 0; second < 4; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce();
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2);
});

it.each([false, true])("权益通知先于领取返回=%s 时，不等待重复整剧详情即可展示连续解锁弹窗", async notifyEntitlement => {
  const h = setup({ automatic: true, episodes: 3, notifyEntitlement }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  const detail = vi.mocked(h.runtime.api.drama);
  const callsBeforeReward = detail.mock.calls.length;
  detail.mockImplementation(() => new Promise<DramaDetail>(() => undefined));

  await h.finish(true);

  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBeInTheDocument();
  expect(detail).toHaveBeenCalledTimes(callsBeforeReward + 1);
  fireEvent.click(screen.getByRole("button", { name: /Watch next ad/ }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 3 }) })).toBeInTheDocument();
  expect(screen.getByText(text("player.autoUnlockProgress", { unlocked: 2, total: 3 }))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
});

it("连续提示期间提前以暂停模式准备当前集，取消后复用同一实例", async () => {
  const h = setup({ automatic: true, episodes: 3 }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBeInTheDocument();
  await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenCalledWith([
    expect.objectContaining({ episodeId: "1", vid: "vid-1" }),
  ], 0));
  expect(screen.queryByText("Preparing episode")).not.toBeInTheDocument();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(vi.mocked(h.engine.mount).mock.calls[0][1]).toMatchObject({ autoplay: false });
  expect(h.engine.play).not.toHaveBeenCalled();
  vi.mocked(h.runtime.clearMediaPreload!).mockClear();
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).not.toBeInTheDocument();
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  expect(vi.mocked(h.runtime.preloadMedia!).mock.calls.map(([, scene]) => scene)).toEqual([0]);
  h.firstFrame("vid-1");
  await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenLastCalledWith([
    expect.objectContaining({ episodeId: "1" }),
  ], 1));
  expect(h.runtime.clearMediaPreload).not.toHaveBeenCalled();
  expect(screen.getByTestId("player-stage")).toHaveClass("chrome-visible");
  const selector = screen.getByRole("button", { name: text("player.episodeSelector") });
  expect(selector).toBeEnabled();
  fireEvent.click(selector);
  expect(screen.getByRole("dialog", { name: text("player.episodeSelector") })).toBeInTheDocument();
});

it("连续广告结算的相邻集许可直接复用，切集不等待目录刷新或再次验权", async () => {
  const h = setup({ automatic: true, episodes: 3, notifyEntitlement: true, playbackInClaim: true });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  const detail = vi.mocked(h.runtime.api.drama);
  detail.mockImplementation(() => new Promise<DramaDetail>(() => undefined));
  const requestsBefore = h.resolvePlay.mock.calls.filter(([, id]) => id === "2").length;
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockContinue") }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 3 }) });
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  fireEvent.click(screen.getByText("测试切至第二集"));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "2" })));
  expect(h.resolvePlay.mock.calls.filter(([, id]) => id === "2")).toHaveLength(requestsBefore);
});

it("领奖确认后弹窗内并行准备暂停播放器，关闭时不等待慢预热或重复创建", async () => {
  const h = setup({ automatic: true, episodes: 3, playbackInClaim: true });
  let finishPreload!: () => void;
  const preload = new Promise<void>(resolve => { finishPreload = resolve; });
  vi.mocked(h.runtime.preloadMedia!).mockImplementationOnce(() => preload);
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  expect(h.runtime.preloadMedia).toHaveBeenCalledWith([expect.objectContaining({ episodeId: "1" })], 0);
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(vi.mocked(h.engine.mount).mock.calls[0][1]).toMatchObject({ autoplay: false });
  expect(h.engine.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  await act(async () => { finishPreload(); await preload; });
  expect(h.engine.mount).toHaveBeenCalledOnce();
  expect(h.engine.destroy).not.toHaveBeenCalled();
});

it("初始预热失败记录脱敏错误并继续暂停准备，关闭后正常恢复", async () => {
  const h = setup({ automatic: true, playbackInClaim: true });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(h.runtime.preloadMedia!).mockRejectedValueOnce(new Error("preload unavailable token=private-value"));
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "reward_media_preload_failed", error: "preload unavailable token=[REDACTED]" }));
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-value");
  expect(h.engine.play).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  expect(h.engine.mount).toHaveBeenCalledOnce();
});

it.each([false, true])("后台目录刷新失败=%s 时，后续领奖不阻塞已就绪当前集", async failDirectory => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = setup({ automatic: true, episodes: 3, notifyEntitlement: true }); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenCalled());
  const resolve = h.resolvePlay.getMockImplementation()!;
  const calls = h.resolvePlay.mock.calls.filter(([, id]) => id === "1").length;
  h.resolvePlay.mockImplementation((dramaId, id) => id === "1" ? new Promise(() => {}) : resolve(dramaId, id));
  if (failDirectory) vi.mocked(h.runtime.api.drama).mockRejectedValue(new Error("directory unavailable token=private-value"));
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockContinue") }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 3 }) });
  expect(h.resolvePlay.mock.calls.filter(([, id]) => id === "1")).toHaveLength(calls);
  fireEvent.click(screen.getByRole("button", { name: text("player.autoUnlockCancel") }));
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  if (failDirectory) {
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "reward_directory_refresh_failed", error: expect.stringContaining("directory unavailable") }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-value");
  } else expect(warning).not.toHaveBeenCalled();
});

it("从已播剧集进入锁定集时保留官方实例，广告完成后直接 playNext", async () => {
  const h = setup();
  h.unlocked.add("1");
  h.open();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  vi.mocked(h.runtime.clearMediaPreload!).mockClear();

  fireEvent.click(screen.getByRole("link", { name: "测试切至第二集" }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  expect(h.engine.destroy).not.toHaveBeenCalled();

  await h.finish(true);
  await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenCalledWith([
    expect.objectContaining({ vid: "vid-1" }),
    expect.objectContaining({ vid: "vid-2" }),
  ], 1));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
  expect(h.engine.mount).toHaveBeenCalledOnce();
  expect(h.engine.destroy).not.toHaveBeenCalled();
  expect(h.engine.play).not.toHaveBeenCalled();
  expect(h.runtime.clearMediaPreload).not.toHaveBeenCalled();
  expect(screen.queryByText("Preparing episode")).not.toBeInTheDocument();
});

it.each(["关闭", "继续广告", "离页", "后台"])("准备未完成时%s，复用准备任务且只在允许时播放", async action => {
  const h = setup({ automatic: true, episodes: 3 });
  const original = vi.mocked(h.engine.mount).getMockImplementation()!;
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  vi.mocked(h.engine.mount).mockImplementation(async (...args) => { await gate; return original(...args); });
  const view = h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  await h.finish(true);
  await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) });
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  if (action === "离页") view.unmount();
  else fireEvent.click(screen.getByRole("button", { name: text(action === "继续广告" ? "player.autoUnlockContinue" : "player.autoUnlockCancel") }));
  if (action === "后台") fireEvent(window, new Event("pagehide"));
  if (action === "继续广告") await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  expect(h.engine.play).not.toHaveBeenCalled();
  await act(async () => { ready(); await gate; });
  expect(h.engine.mount).toHaveBeenCalledOnce();
  if (action === "关闭") await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  else expect(h.engine.play).not.toHaveBeenCalled();
  if (action === "后台") {
    fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(h.engine.play).toHaveBeenCalledOnce());
  }
});

it("切到另一锁定集不会沿用上一集广告结果", async () => {
  const h = setup(); h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("link", { name: "测试切至第二集" }));
  await waitFor(() => expect(h.resolvePlay).toHaveBeenCalledWith("1", "2"));
  await h.finish(true);
  expect(h.engine.mount).not.toHaveBeenCalled();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  // 旧路由的广告回调不能为新锁定集或已离开的集发起领奖。
  expect(h.runtime.claimReward).not.toHaveBeenCalled();
});

it("广告错误会脱敏记录，并允许用户主动重试", async () => {
  const h = setup();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(h.runtime.showRewardedAd).mockRejectedValueOnce(new Error("SDK unavailable token=secret"));
  h.open();
  await screen.findByRole("alert");
  expect(log).toHaveBeenCalledWith({ event: "episode_unlock_failed", error: "SDK unavailable token=[REDACTED]" });
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
});

it("已解锁当前集会直接播放，邻集预取不会触发广告", async () => {
  const h = setup(); h.unlocked.add("1"); h.open();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  await waitFor(() => expect(h.resolvePlay).toHaveBeenCalledWith("1", "2"));
  expect(h.runtime.showRewardedAd).not.toHaveBeenCalled();
});


it.each([false, true])("新版完整结算回包，权益通知=%s，连续解锁不重复查询目录或目标集授权", async notifyEntitlement => {
  const h = setup({ automatic: true, episodes: 3, notifyEntitlement, playbackInClaim: true, directoryInClaim: true });
  h.open();
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledOnce());
  const before = vi.mocked(h.runtime.api.drama).mock.calls.length;
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 2 }) })).toBeInTheDocument();
  expect(h.runtime.api.drama).toHaveBeenCalledTimes(before);
  fireEvent.click(screen.getByRole("button", { name: /Watch next ad/ }));
  await waitFor(() => expect(h.runtime.showRewardedAd).toHaveBeenCalledTimes(2));
  await h.finish(true);
  expect(await screen.findByRole("dialog", { name: text("player.autoUnlockTitle", { number: 3 }) })).toBeInTheDocument();
  expect(h.runtime.api.drama).toHaveBeenCalledTimes(before);
  expect(screen.getByText(text("player.autoUnlockProgress", { unlocked: 2, total: 3 }))).toBeInTheDocument();
});
