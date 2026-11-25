import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "./App";
import { text } from "./copy";
import type { AdShow, BootstrapResult, DramaDetail, PlayResolveResult, RewardClaim } from "./domain/types";
import type { PlaybackEngine } from "./player/playbackEngine";
import { createRuntime } from "./runtime/runtime";
import { createTikTokFixture } from "./test/tiktokFixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.TTMinis;
  window.location.hash = "";
});

it("真实 App、HTTP 客户端和广告运行时：某剧已达标，三部零进度剧仍各展示三次，VIP 和可播放响应不跳过入剧", async () => {
  // UID 与剧目组合对应故障报告；网络和官方 SDK 回调均为测试替身，不访问测试库。
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  const platform = createTikTokFixture();
  window.TTMinis = platform.sdk;
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const bootstrap: BootstrapResult = {
    applicationId: "3", tiktokAppId: "test-app", visitorId: "101006", visitorToken: "fixture-token",
    appName: "Glimora", logoUrl: "", complianceBaseUrl: "", identityState: "tiktok_authenticated",
    playbackSdk: { provider: "tiktok_minis", channel: "byteplus" },
    vipState: { active: true, adCount: 1, requiredCount: 1, progressDate: "today", validUntil: deadline },
    monetization: { status: "enabled", strategy: "rules", freeEpisodeCount: 1,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 1, title: "", content: "" } },
  };
  const dramas: DramaDetail[] = ["1", "4", "5", "6"].map(id => ({
    id, firstEpisodeId: `episode-${id}`, title: `Title ${id}`, description: "", coverUrl: "",
    episodeCount: 1, status: "ongoing", tags: [],
    episodes: [{ id: `episode-${id}`, dramaId: id, number: 1, title: "Episode 1", description: "",
      posterUrl: "", durationSeconds: 60, accessMode: "free" }],
  }));
  const playable = (id: string): PlayResolveResult => {
    const drama = dramas.find(item => item.id === id)!;
    return { status: "playable", drama, episode: drama.episodes[0], playback: {
      channel: "byteplus", albumId: `album-${id}`, episodeId: `official-${id}`, vid: `vid-${id}`,
      title: drama.title, posterUrl: "", episodeNumber: 1, durationSeconds: 60,
    } };
  };
  const shows = new Map<string, number>([["1", 3]]);
  const facts: AdShow[] = [];
  const queries: string[] = [];
  const entryState = (id: string) => ({ enabled: true, scope: "user_drama", countBy: "shown", shownCount: shows.get(id) ?? 0,
    completedCount: 0, requiredCount: 3, progressDate: "today", validUntil: deadline,
    offer: { offerId: "entry-offer", kind: "rewarded_entry", adUnitId: "entry-placement" } });
  const response = (data: unknown) => new Response(JSON.stringify({ serverTime: new Date().toISOString(), data }));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://fixture.invalid");
    const path = url.pathname;
    if (path.endsWith("/session") || path.endsWith("/open/app-config")) return response(bootstrap);
    if (path.endsWith("/open/review-home")) return response({ tiktokAppId: "test-app", enabled: false, revision: 0, dramas: [] });
    if (path.endsWith("/me/vip")) return response(bootstrap.vipState);
    if (path.endsWith("/open/catalog")) return response({ tiktokAppId: "test-app", dramas });
    if (path.includes("/open/home/")) return response([]);
    if (path.endsWith("/play/entry")) {
      const { dramaId, episodeId } = JSON.parse(String(init?.body)) as { dramaId: string; episodeId: string };
      const drama = dramas.find(item => item.id === dramaId)!;
      const status = entryState(dramaId);
      queries.push(dramaId);
      return response({ entry: { target: { dramaId, episodeId }, drama, episode: drama.episodes[0],
        entryAdStatus: status, vipState: bootstrap.vipState, ...(status.shownCount >= status.requiredCount ? { play: playable(dramaId) } : {}) } });
    }
    if (path.endsWith("/me/entry-ad")) {
      const id = url.searchParams.get("dramaId")!;
      queries.push(id);
      expect(dramas.some(drama => drama.id === id)).toBe(true);
      return response({ enabled: true, scope: "user_drama", countBy: "shown", shownCount: shows.get(id) ?? 0,
        completedCount: 0, requiredCount: 3, progressDate: "today", validUntil: deadline,
        offer: { offerId: "entry-offer", kind: "rewarded_entry", adUnitId: "entry-placement" } });
    }
    if (path.endsWith("/me/entry-ad/shows")) {
      const show = JSON.parse(String(init?.body)) as AdShow;
      expect(show.scene).toBe("entry_reward");
      expect(show.adUnitId).toBe("entry-placement");
      expect(show.dramaId).toBeTruthy();
      facts.push(show);
      shows.set(show.dramaId!, (shows.get(show.dramaId!) ?? 0) + 1);
      return response({ accepted: true, entryAdStatus: entryState(show.dramaId!) });
    }
    if (path.endsWith("/reward-grants")) {
      const claim = JSON.parse(String(init?.body)) as RewardClaim;
      return response({ claimId: claim.claimId, status: (shows.get(claim.dramaId!) ?? 0) >= 3 ? "entry_satisfied" : "granted",
        rewardType: "entry_progress", unlocked: false, dramaId: claim.dramaId, episodeId: "", entryAdStatus: entryState(claim.dramaId!) });
    }
    if (path.includes("/play/resolve")) {
      const body = JSON.parse(String(init?.body)) as { dramaId: string; episodeIds?: string[] };
      return response(body.episodeIds ? body.episodeIds.map(() => playable(body.dramaId)) : playable(body.dramaId));
    }
    if (path.includes("/dramas/")) return response(dramas.find(drama => path.endsWith(`/${drama.id}`)));
    if (path.endsWith("/metrics")) return response({ accepted: true });
    throw new Error(`测试未声明的 API 路径: ${path}`);
  }));
  const mounted: string[] = [];
  const runtime = createRuntime();
  runtime.preparePlayback = vi.fn(async () => undefined);
  runtime.preloadMedia = vi.fn(async () => undefined);
  runtime.createPlaybackEngine = (): PlaybackEngine => ({
    mount: vi.fn(async (_root, source) => {
      const id = source.vid!.replace("vid-", "");
      expect(shows.get(id)).toBe(3);
      mounted.push(id);
      return true;
    }),
    switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined),
    pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  });
  render(<App runtime={runtime} />);
  await waitFor(() => expect(runtime.getVisitorID()).toBe("101006"));
  for (const [index, drama] of dramas.entries()) {
    fireEvent.click(await screen.findByRole("link", { name: new RegExp(`^${drama.title} `) }));
    await waitFor(() => expect(queries).toContain(drama.id));
    if (index > 0) {
      for (let count = 1; count <= 3; count++) {
        await waitFor(() => expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledTimes((index - 1) * 3 + count));
        expect(mounted).not.toContain(drama.id);
        // 成功展示已记入，但广告退出前仍不可起播；完播结算经过真实客户端。
        await waitFor(() => expect(shows.get(drama.id)).toBe(count));
        await act(async () => platform.closeRewardedAd({ isEnded: true }));
      }
    }
    await waitFor(() => expect(mounted).toContain(drama.id));
    fireEvent.click(screen.getByRole("button", { name: text("common.back") }));
  }
  expect(mounted).toEqual(["1", "4", "5", "6"]);
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledTimes(9);
  for (const id of ["4", "5", "6"]) expect(facts.filter(show => show.dramaId === id)).toHaveLength(3);
  // 本用例连续走完四次入剧和九次广告结算，为全量测试并行争用 CPU 留出时间。
}, 20_000);
