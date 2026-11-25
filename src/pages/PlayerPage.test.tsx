import { ServerClock } from "../domain/serverTime";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdExperience, ClaimResult, DramaDetail, EntryAdStatus, MiniDramaApi, PlayResolveResult } from "../domain/types";
import { LocalLibraryStore } from "../domain/localLibrary";
import { SDKPlaybackEngine } from "../player/tiktokMinisPlayerEngine";
import { directPlayerOptions, validateDirectSource } from "../player/vePlayerEngine";
import type { PlaybackCallbacks, PlaybackEngine } from "../player/playbackEngine";
import { RuntimeContext } from "../runtime/RuntimeContext";
import type { EntitlementChange, Runtime } from "../runtime/runtime";
import { text } from "../copy";
import { episodeSwipeOffset, PlayerPage } from "./PlayerPage";

const drama: DramaDetail = {
  id: "drama-1",
  firstEpisodeId: "episode-1",
  title: "The Last Alibi",
  description: "",
  coverUrl: "poster.jpg",
  episodeCount: 3,
  tags: [],
  status: "completed",
  episodes: [1, 2, 3].map((number) => ({
    id: `episode-${number}`,
    dramaId: "drama-1",
    number,
    title: `Episode ${number}`,
    description: number === 1 ? "The message changes everything." : "",
    posterUrl: "poster.jpg",
    durationSeconds: 60,
    accessMode: "free" as const,
  })),
};

it("前后台恢复重新验权，手动暂停和离页后的旧响应不自动播放", async () => {
  const listeners = new Map<string, () => void>();
  const previousSDK = window.TTMinis;
  window.TTMinis = { on: (event: string, fn: () => void) => { listeners.set(event, fn); return event; }, off: vi.fn() } as unknown as NonNullable<typeof window.TTMinis>;
  let callbacks: PlaybackCallbacks = {};
  let paused = false;
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, next) => { callbacks = next || {}; return true; }),
    switchSource: vi.fn(async () => {}),
    play: vi.fn(async () => { paused = false; callbacks.onPlay?.(); }),
    pause: vi.fn(() => { paused = true; callbacks.onPause?.(); }),
    seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 10, duration: 60, paused, ended: false }),
  };
  const resolvePlay = vi.fn(async (_id: string, id: string): Promise<PlayResolveResult> => {
    const episode = drama.episodes.find((item) => item.id === id)!;
    return { status: "playable", drama, episode, playback: playbackFor(episode) };
  });
  const runtime = { api: { entryAdStatus: async () => ({ enabled: false, completedCount: 0, requiredCount: 0 }), drama: async () => drama, resolvePlay }, createPlaybackEngine: () => engine, ...runtimeAdExperience } as unknown as Runtime;
  const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  try {
    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    act(() => callbacks.onPlay?.());
    const before = resolvePlay.mock.calls.filter(([, id]) => id === "episode-1").length;
    act(() => listeners.get("minis.hide")!());
    expect(paused).toBe(true);
    act(() => listeners.get("minis.show")!());
    await waitFor(() => expect(engine.play).toHaveBeenCalledOnce());
    expect(resolvePlay.mock.calls.filter(([, id]) => id === "episode-1")).toHaveLength(before + 1);
    act(() => engine.pause());
    act(() => { listeners.get("minis.hide")!(); listeners.get("minis.show")!(); });
    expect(engine.play).toHaveBeenCalledOnce();
    paused = false;
    let finish!: (result: PlayResolveResult) => void;
    resolvePlay.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => { listeners.get("minis.hide")!(); listeners.get("minis.show")!(); });
    view.unmount();
    await act(async () => finish({ status: "playable", drama, episode: drama.episodes[0], playback: playbackFor(drama.episodes[0]) }));
    expect(engine.play).toHaveBeenCalledOnce();
  } finally { view.unmount(); window.TTMinis = previousSDK; }
});

function dramaWithEpisodes(count: number): DramaDetail {
  return {
    ...drama,
    episodeCount: count,
    episodes: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      return {
        ...drama.episodes[0],
        id: `episode-${number}`,
        number,
        title: `Episode ${number}`,
        description: "",
      };
    }),
  };
}

const disabledAdExperience: AdExperience = {
  vipState: { active: false, adCount: 0, requiredCount: 3, progressDate: "2026-07-10" },
  monetizationPolicy: {
    status: "disabled",
    strategy: "episode_reward",
    freeEpisodeCount: 3,
    episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
    vip: {
      enabled: false,
      requiredAdCount: 3,
      title: "VIP for today",
      content: "",
    },
  },
};

const enabledEpisodeAdExperience: AdExperience = {
  ...disabledAdExperience,
  monetizationPolicy: {
    ...disabledAdExperience.monetizationPolicy,
    status: "enabled",
  },
};

const enabledVIPExperience: AdExperience = {
  ...disabledAdExperience,
  vipState: {
    active: false,
    adCount: 1,
    requiredCount: 5,
    progressDate: "2026-07-31",
  },
  monetizationPolicy: {
    ...disabledAdExperience.monetizationPolicy,
    status: "enabled",
    vip: {
      enabled: true,
      requiredAdCount: 3,
      title: "VIP for today",
      content: "Watch three ads for access today.",
    },
  },
  vipOffer: {
    offerId: "vip-offer-1",
    adUnitId: "vip-placement-1",
    kind: "rewarded_vip",
  },
};

const runtimeAdExperience = {
  getAdExperience: () => disabledAdExperience,
  subscribeAdExperience: () => () => undefined,
  watchVIPAd: vi.fn(),
};

// jsdom 无布局与触摸合成，直接发送指针序列验证三屏轨道越过阈值后的页面交接。
function finishNextSlide(stage: HTMLElement) {
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup", y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 11 }, pointerType: { value: "touch" } });
    fireEvent(stage, event);
  };
  act(() => { pointer("pointerdown", 520); pointer("pointermove", 300); pointer("pointerup", 300); });
}

function playbackFor(episode: DramaDetail["episodes"][number]) {
  return {
    channel: "byteplus" as const,
    albumId: "album-1",
    episodeId: `platform-episode-${episode.number}`,
    vid: `vid-${episode.number}`,
    posterUrl: episode.posterUrl,
    title: episode.title,
    episodeNumber: episode.number,
    durationSeconds: episode.durationSeconds,
  };
}

function createPlayerRuntime(
  engine: PlaybackEngine,
  currentDrama: DramaDetail = drama,
) {
  const localLibrary = {
    isFollowing: vi.fn(() => false),
    setFollow: vi.fn(),
    recordProgress: vi.fn(),
  };
  const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
    drama: vi.fn(async () => currentDrama),
    resolvePlay: vi.fn(async (_dramaId: string, episodeId: string): Promise<PlayResolveResult> => {
      const episode = currentDrama.episodes.find((item) => item.id === episodeId)!;
      return {
        status: "playable",
        drama: currentDrama,
        episode,
        playback: playbackFor(episode),
      };
    }),
  } as unknown as MiniDramaApi;
  const runtime = {
    getVisitorID: () => "visitor-1",
    api,
    bootstrap: vi.fn(async () => undefined),
    createPlaybackEngine: () => engine,
    showRewardedAd: vi.fn(),
    claimReward: vi.fn(),
    localLibrary,
    ...runtimeAdExperience,
  } as unknown as Runtime;
  return { api, runtime, localLibrary };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([
  [true, undefined, false, true],
  [false, undefined, false, true],
  [true, "tiktok_minis", false, true],
  [true, "byteplus_web", false, true],
  [true, "byteplus_web", true, true],
  [false, "tiktok_minis", false, false],
  [false, "byteplus_web", false, false],
] as const)("详情前台时间到点后按原门禁顺序执行，入剧广告 %s，锁定通道 %s，VIP 解锁 %s，VIP 门禁 %s", async (withEntryAd, lockedProvider, vipUnlocks, withVIP) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  let paused = false;
  let position = 0;
  const engine: PlaybackEngine = {
    mount: vi.fn(async () => true),
    play: vi.fn(async () => { paused = false; }),
    pause: vi.fn(() => { paused = true; }),
    switchSource: vi.fn(async () => {}), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: position, duration: 60, paused, ended: false }),
  };
  const { runtime, api } = createPlayerRuntime(engine);
  const episode = drama.episodes[0];
  const direct = lockedProvider === "byteplus_web";
  const fullSource = direct ? new ServerClock().bind({
    ...playbackFor(episode), provider: "byteplus_web" as const, vid: "full-vid",
    albumId: undefined, episodeId: undefined, playAuthToken: "full-test-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, new Date().toISOString(), performance.now(), 0, 0) : playbackFor(episode);
  const previewSource = direct
    ? { ...fullSource, vid: "clip-vid", durationSeconds: 5, playAuthToken: "clip-test-token" }
    : fullSource;
  const offer = { offerId: "episode-offer", adUnitId: "episode-ad", kind: "rewarded_episode" } as const;
  const playable = { status: "playable", drama, episode, playback: fullSource } as const;
  if (lockedProvider) vi.mocked(api.resolvePlay).mockResolvedValue({
    status: "access_required", drama, episode, offer, entryPreview: { seconds: 5, playback: previewSource },
  });
  if (direct && !vipUnlocks) vi.mocked(api.resolvePlay).mockResolvedValueOnce({
    status: "access_required", drama, episode, offer, entryPreview: { seconds: 5 },
  });
  const listeners = new Set<() => void>();
  let experience: AdExperience = {
    ...disabledAdExperience,
    vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "2026-11-09" },
    monetizationPolicy: { ...disabledAdExperience.monetizationPolicy, status: "enabled", freeEpisodeCount: lockedProvider ? 0 : 1, entryAdDelaySeconds: 5,
      vip: { enabled: withVIP, requireBeforePlayback: withVIP, requiredAdCount: 1, title: "", content: "" } },
  };
  runtime.getAdExperience = () => experience;
  runtime.subscribeAdExperience = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const entitlementListeners = new Set<(event: EntitlementChange) => void>();
  runtime.getApplicationID = () => "app";
  runtime.subscribeEntitlements = listener => { entitlementListeners.add(listener); return () => { entitlementListeners.delete(listener); }; };
  const entryStatus = (completedCount: number): EntryAdStatus => new ServerClock().bind({
    enabled: true, scope: "user", countBy: "completed", completedCount, requiredCount: 1, progressDate: "2026-11-09",
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    offer: { offerId: "entry-offer", adUnitId: "entry-ad", kind: "rewarded_entry" },
  } satisfies EntryAdStatus, new Date().toISOString(), performance.now(), 0, 0);
  if (withEntryAd) vi.mocked(api.entryAdStatus).mockResolvedValue(entryStatus(0));
  const order: string[] = [];
  runtime.hasPendingAdClaim = () => false;
  runtime.showEntryAd = vi.fn<Runtime["showEntryAd"]>(async () => { order.push("入剧广告"); return { status: "completed" }; });
  vi.mocked(runtime.showRewardedAd).mockImplementation(async () => {
    order.push("逐集广告");
    return { status: "completed" };
  });
  vi.mocked(runtime.claimReward).mockImplementation(async (claim) => {
    if (claim.offerId === offer.offerId) {
      order.push("逐集结算");
      vi.mocked(api.resolvePlay).mockResolvedValue(playable);
      return { claimId: "episode-claim", status: "granted", rewardType: "episode_unlock", unlocked: true,
        dramaId: drama.id, episodeId: episode.id, playback: playable };
    }
    order.push("入剧结算");
    return { claimId: "entry-claim", status: "granted", rewardType: "entry_progress", unlocked: false,
      dramaId: drama.id, episodeId: "", entryAdStatus: entryStatus(1) };
  });
  runtime.watchVIPAd = vi.fn<Runtime["watchVIPAd"]>(async () => {
    order.push("VIP 广告");
    return { claimId: "vip-claim", status: "granted", rewardType: "vip_progress", unlocked: false,
      dramaId: "", episodeId: "", vipState: { ...experience.vipState, adCount: 1 } };
  });
  runtime.claimVIP = vi.fn(async () => {
    experience = { ...experience, vipState: { ...experience.vipState, active: true, adCount: 1 } };
    listeners.forEach(listener => listener());
    if (vipUnlocks) {
      vi.mocked(api.resolvePlay).mockResolvedValue(playable);
      entitlementListeners.forEach(listener => listener({ revision: 1, applicationId: "app", visitorId: "visitor-1", identityGeneration: 1, rewardType: "vip_progress" }));
    }
    return experience.vipState;
  });
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes>
    <Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} />
  </Routes></MemoryRouter></RuntimeContext.Provider>);
  await act(async () => {});
  if (direct && !vipUnlocks) {
    expect(api.resolvePlay).toHaveBeenCalledOnce();
    expect(engine.mount).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
  }
  expect(engine.mount).toHaveBeenCalledOnce();
  expect(engine.mount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ vid: previewSource.vid }), expect.anything());
  // 首帧和进度回调均未到达，页面时钟仍继续；入剧时播放到的位置可用于正片续播。
  position = 2.5;
  await act(async () => vi.advanceTimersByTimeAsync(direct && !vipUnlocks ? 2_999 : 4_999));
  expect(order).toEqual([]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(engine.pause).toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(10));
  if (withVIP) await act(async () => fireEvent.click(screen.getByRole("button", { name: "Claim today's VIP" })));
  expect(engine.play).toHaveBeenCalledOnce();
  expect(order).toEqual([
    ...(withEntryAd ? ["入剧广告", "入剧结算"] : []), ...(withVIP ? ["VIP 广告"] : []),
    ...(lockedProvider && !vipUnlocks ? ["逐集广告", "逐集结算"] : []),
  ]);
  expect(engine.mount).toHaveBeenCalledTimes(direct ? 2 : 1);
  if (direct) expect(engine.mount).toHaveBeenLastCalledWith(expect.anything(),
    expect.objectContaining({ vid: "full-vid", startTime: 2.5 }), expect.anything());
  expect(engine.switchSource).not.toHaveBeenCalled();
  expect(engine.snapshot().currentTime).toBe(2.5);
});

it.each(["tiktok_minis", "byteplus_web"] as const)("播放器 %s 初始化未完成时到点拉起广告，迟到回调不能开始播放", async provider => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  let finishMount!: (mounted: boolean) => void;
  let callbacks: PlaybackCallbacks = {};
  const engine: PlaybackEngine = {
    mount: vi.fn<PlaybackEngine["mount"]>((_root, _source, next) => {
      callbacks = next ?? {};
      return new Promise(resolve => { finishMount = resolve; });
    }),
    play: vi.fn(async () => {}), pause: vi.fn(), switchSource: vi.fn(async () => {}), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 0, paused: true, ended: false }),
  };
  const { api, runtime } = createPlayerRuntime(engine);
  const episode = drama.episodes[0];
  const source = { ...playbackFor(episode), provider: "tiktok_minis" as const };
  const playback = provider === "tiktok_minis" ? source : new ServerClock().bind({
    ...source, provider, albumId: undefined, episodeId: undefined, playAuthToken: "test-playback-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, new Date().toISOString(), performance.now(), 0, 0);
  vi.mocked(api.resolvePlay).mockResolvedValue({ status: "playable", drama, episode, playback });
  vi.mocked(api.entryAdStatus).mockResolvedValue(new ServerClock().bind({
    enabled: true, scope: "user", countBy: "completed", completedCount: 0, requiredCount: 1, progressDate: "2026-11-09",
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    offer: { offerId: "entry-offer", adUnitId: "entry-ad", kind: "rewarded_entry" },
  } satisfies EntryAdStatus, new Date().toISOString(), performance.now(), 0, 0));
  const experience: AdExperience = {
    ...disabledAdExperience,
    monetizationPolicy: { ...disabledAdExperience.monetizationPolicy, status: "enabled", entryAdDelaySeconds: 4 },
  };
  runtime.getAdExperience = () => experience;
  runtime.hasPendingAdClaim = () => false;
  runtime.showEntryAd = vi.fn<Runtime["showEntryAd"]>(() => new Promise(() => {}));
  runtime.reportPlaybackEvent = vi.fn();
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes>
    <Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} />
  </Routes></MemoryRouter></RuntimeContext.Provider>);
  await act(async () => {});
  expect(engine.mount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider }), expect.anything());
  await act(async () => vi.advanceTimersByTimeAsync(3_999));
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(runtime.showEntryAd).toHaveBeenCalledOnce();
  expect(engine.destroy).toHaveBeenCalledOnce();
  await act(async () => {
    callbacks.onReady?.();
    callbacks.onPlay?.();
    finishMount(true);
  });
  expect(runtime.reportPlaybackEvent).not.toHaveBeenCalledWith("ep_play", expect.anything(), episode.id);
  expect(engine.play).not.toHaveBeenCalled();
});

describe("播放页权益通知", () => {
  it("领奖后保留已验权相邻集，目录刷新未完成时首次手动切集不重复请求", async () => {
    let callbacks: PlaybackCallbacks = {};
    let listener!: (event: EntitlementChange) => void;
    const detail = dramaWithEpisodes(3);
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
    };
    const { api, runtime } = createPlayerRuntime(engine, detail);
    runtime.getApplicationID = () => "app-1";
    runtime.getEntitlementRevision = () => 0;
    runtime.subscribeEntitlements = next => { listener = next; return () => undefined; };
    runtime.preloadMedia = vi.fn(async () => {});
    runtime.resolvePlaybackBatch = vi.fn(async (_dramaId: string, ids: string[]) => ids.map(id => {
      const episode = detail.episodes.find(item => item.id === id)!;
      return { status: "playable" as const, drama: detail, episode, playback: playbackFor(episode) };
    }));
    vi.mocked(api.drama).mockResolvedValueOnce(detail).mockImplementation(() => new Promise(() => {}));

    render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce());
    act(() => callbacks.onFirstFrame?.("vid-1"));
    await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([
      expect.objectContaining({ vid: "vid-1" }),
      expect.objectContaining({ vid: "vid-2" }),
      expect.objectContaining({ vid: "vid-3" }),
    ], 1));
    const current = detail.episodes[0];
    await act(async () => listener({
      revision: 1, applicationId: "app-1", visitorId: "visitor-1", identityGeneration: 1,
      rewardType: "episode_unlock", dramaId: detail.id, episodeId: current.id,
      playback: { status: "playable", drama: detail, episode: current, playback: playbackFor(current) },
    }));
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
    expect(api.resolvePlay).not.toHaveBeenCalledWith(detail.id, "episode-2");
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce();
  });

  it.each([undefined, "https://images.example/first.jpg"])("首集授权未返回时优先首帧图，缺图回退封面：%s", async (firstEpisodePosterUrl) => {
    const engine = { destroy: vi.fn() } as unknown as PlaybackEngine;
    const { api, runtime } = createPlayerRuntime(engine);
    runtime.getCachedPublicCatalog = () => ({ dramas: [{ ...drama, firstEpisodePosterUrl, coverUrl: "https://images.example/cover.jpg" }] });
    vi.mocked(api.drama).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(api.resolvePlay).mockImplementation(() => new Promise(() => undefined));

    const { container } = render(<RuntimeContext.Provider value={runtime}>
      <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
        <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
      </MemoryRouter>
    </RuntimeContext.Provider>);

    await waitFor(() => expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", firstEpisodePosterUrl || "https://images.example/cover.jpg"));
  });

  it("无历史时直接使用首页链接携带的首集首帧图", async () => {
    const engine = { destroy: vi.fn() } as unknown as PlaybackEngine;
    const { api, runtime } = createPlayerRuntime(engine);
    vi.mocked(api.drama).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(api.resolvePlay).mockImplementation(() => new Promise(() => undefined));

    const { container } = render(<RuntimeContext.Provider value={runtime}>
      <MemoryRouter initialEntries={["/watch/drama-1/episode-1?firstEpisodePosterUrl=https%3A%2F%2Fimages.example%2Ffrom-home.jpg"]}>
        <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
      </MemoryRouter>
    </RuntimeContext.Provider>);

    await waitFor(() => expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", "https://images.example/from-home.jpg"));
  });

  it("首次真实播放时把链接中的 firstEpisodePosterUrl 保存为历史 posterUrl", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; callbacks.onReady?.(); return true; }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
    };
    const { runtime, localLibrary } = createPlayerRuntime(engine);

    render(<RuntimeContext.Provider value={runtime}>
      <MemoryRouter initialEntries={["/watch/drama-1/episode-1?firstEpisodePosterUrl=https%3A%2F%2Fimages.example%2Ffrom-home.jpg"]}>
        <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
      </MemoryRouter>
    </RuntimeContext.Provider>);

    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    act(() => callbacks.onTimeUpdate?.({ currentTime: 6, duration: 60, paused: false, ended: false }));
    await waitFor(() => expect(localLibrary.recordProgress).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: "episode-1",
      posterUrl: "https://images.example/from-home.jpg",
    })));
  });

  it("有历史时使用该剧唯一播放记录中的 posterUrl", async () => {
    const engine = { destroy: vi.fn() } as unknown as PlaybackEngine;
    const { api, runtime } = createPlayerRuntime(engine);
    const library = new LocalLibraryStore("poster-app", "poster-visitor", { getItem: () => null, setItem: () => {} });
    vi.spyOn(library, "history").mockReturnValue([{
      dramaId: "drama-1", episodeId: "episode-2", episodeNumber: 2,
      progressSeconds: 24, durationSeconds: 60,
      posterUrl: "https://images.example/cached-episode-2.jpg",
      updatedAt: "2026-09-23T00:00:00.000Z",
    }]);
    runtime.localLibrary = library;
    vi.mocked(api.drama).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(api.resolvePlay).mockImplementation(() => new Promise(() => undefined));

    const { container } = render(<RuntimeContext.Provider value={runtime}>
      <MemoryRouter initialEntries={["/watch/drama-1/episode-2"]}>
        <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
      </MemoryRouter>
    </RuntimeContext.Provider>);

    await waitFor(() => expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", "https://images.example/cached-episode-2.jpg"));
  });

  it("仅当前主体和同剧到账通知刷新当前集，重复事件不重复请求，卸载后释放订阅", async () => {
    const engine = { destroy: vi.fn() } as unknown as PlaybackEngine;
    const { api, runtime } = createPlayerRuntime(engine);
    vi.mocked(api.resolvePlay).mockResolvedValue({ status: "unavailable" });
    const listeners = new Set<(event: EntitlementChange) => void>();
    runtime.getApplicationID = () => "app-1";
    runtime.getEntitlementRevision = () => 0;
    runtime.subscribeEntitlements = (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    const publish = (override: Partial<EntitlementChange>) => {
      const event: EntitlementChange = {
        revision: 1, applicationId: "app-1", visitorId: "visitor-1", identityGeneration: 1,
        rewardType: "episode_unlock", dramaId: "drama-1", episodeId: "episode-1", ...override,
      };
      listeners.forEach((listener) => listener(event));
    };
    const { unmount } = render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-2"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );
    await screen.findByText(text("player.openError"));
    expect(api.resolvePlay).toHaveBeenCalledTimes(1);
    act(() => {
      publish({ applicationId: "old-app" });
      publish({ visitorId: "old-visitor" });
      publish({ dramaId: "other-drama" });
    });
    expect(api.resolvePlay).toHaveBeenCalledTimes(1);
    // 原奖励来自第一集，也可能解锁正在观看的第二集，不能只匹配 episodeId。
    await act(async () => publish({ revision: 2 }));
    expect(api.resolvePlay).toHaveBeenLastCalledWith("drama-1", "episode-2");
    expect(api.resolvePlay).toHaveBeenCalledTimes(2);
    // 奖励可能覆盖多集，选集面板必须重新读取服务端访问状态，不能继续复用旧目录。
    expect(api.drama).toHaveBeenCalledTimes(2);
    act(() => publish({ revision: 2 }));
    expect(api.resolvePlay).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("VIP 进度未达标不重验，确认生效或到期时刷新当前剧集", async () => {
    const engine = { destroy: vi.fn() } as unknown as PlaybackEngine;
    const { api, runtime } = createPlayerRuntime(engine);
    vi.mocked(api.resolvePlay).mockResolvedValue({ status: "unavailable" });
    let listener!: (event: EntitlementChange) => void;
    let experience = disabledAdExperience;
    runtime.getApplicationID = () => "app-1";
    runtime.getAdExperience = () => experience;
    runtime.subscribeEntitlements = (next) => { listener = next; return () => undefined; };
    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );
    await screen.findByText(text("player.openError"));
    const event: EntitlementChange = {
      revision: 1, applicationId: "app-1", visitorId: "visitor-1", identityGeneration: 1,
      rewardType: "vip_progress",
    };
    act(() => listener(event));
    expect(api.resolvePlay).toHaveBeenCalledTimes(1);
    experience = { ...disabledAdExperience, vipState: { ...disabledAdExperience.vipState, active: true } };
    await act(async () => listener({ ...event, revision: 2 }));
    expect(api.resolvePlay).toHaveBeenCalledTimes(2);
    experience = disabledAdExperience;
    await act(async () => listener({ ...event, revision: 3, cause: "vip_recheck" }));
    expect(api.resolvePlay).toHaveBeenCalledTimes(3);
  });
});

describe("episodeSwipeOffset", () => {
  it("accepts intentional vertical swipes and rejects short or horizontal gestures", () => {
    expect(episodeSwipeOffset({ x: 100, y: 220 }, { x: 104, y: 110 })).toBe(1);
    expect(episodeSwipeOffset({ x: 100, y: 110 }, { x: 96, y: 220 })).toBe(-1);
    expect(episodeSwipeOffset({ x: 100, y: 220 }, { x: 108, y: 180 })).toBe(0);
    expect(episodeSwipeOffset({ x: 40, y: 180 }, { x: 180, y: 110 })).toBe(0);
  });
});

describe("PlayerPage", () => {
  it.each([true, false])("首页已确定具体分集、有历史=%s：播放对应集但始终从头开始", async (hasHistory) => {
    const library = new LocalLibraryStore("resume-app", "resume-visitor", { getItem: () => null, setItem: () => {} });
    vi.spyOn(library, "history").mockReturnValue(hasHistory ? [
      { dramaId: "drama-1", episodeId: "episode-3", episodeNumber: 3, progressSeconds: 8, durationSeconds: 60, updatedAt: "2026-09-16T01:00:00Z" },
      { dramaId: "drama-1", episodeId: "episode-2", episodeNumber: 2, progressSeconds: 24, durationSeconds: 60, updatedAt: "2026-09-17T01:00:00Z" },
    ] : []);
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, callbacks) => { callbacks?.onReady?.(); return true; }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
    };
    const { runtime } = createPlayerRuntime(engine);
    runtime.localLibrary = library;
    render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={[`/watch/drama-1/${hasHistory ? "episode-2" : "episode-1"}`]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    expect(runtime.api.resolvePlay).toHaveBeenCalledWith("drama-1", hasHistory ? "episode-2" : "episode-1");
    if (hasHistory) {
      expect(runtime.api.resolvePlay).not.toHaveBeenCalledWith("drama-1", "episode-1");
    }
    expect(engine.seek).not.toHaveBeenCalled();
    expect(engine.mount).toHaveBeenCalledWith(expect.any(HTMLElement), expect.not.objectContaining({ autoplay: false }), expect.any(Object));
  });

  it("有历史进度时不定位，正常播放确认后撤掉加载脉冲", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, source, value) => {
        callbacks = value || {};
        callbacks.onReady?.();
        return true;
      }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
    };
    const { runtime } = createPlayerRuntime(engine);
    runtime.localLibrary = {
      ...runtime.localLibrary,
      history: () => [{ dramaId: "drama-1", episodeId: "episode-2", episodeNumber: 2, progressSeconds: 24, durationSeconds: 60, updatedAt: "2026-09-23T00:00:00.000Z" }],
    } as Runtime["localLibrary"];

    const { container } = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-2"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);

    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    expect(engine.mount).toHaveBeenCalledWith(expect.any(HTMLElement), expect.not.objectContaining({ autoplay: false }), expect.any(Object));
    expect(engine.seek).not.toHaveBeenCalled();
    expect(container.querySelector("main")).toHaveClass("is-media-loading");

    act(() => callbacks.onPlay?.());
    expect(container.querySelector("main")).not.toHaveClass("is-media-loading");
  });

  it("主流程：播放进度 -> 本地保存 -> 重载从头播放", async () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
    const previousLibrary = new LocalLibraryStore("test-app", "visitor-1", storage);
    previousLibrary.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 24, durationSeconds: 60 });
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; callbacks.onReady?.(); return true; }),
      switchSource: vi.fn(async () => { callbacks.onPlay?.(); }),
      play: vi.fn(async () => undefined), pause: vi.fn(), seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })), destroy: vi.fn(),
    };
    const { runtime } = createPlayerRuntime(engine);
    runtime.localLibrary = new LocalLibraryStore("test-app", "visitor-1", storage);
    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );
    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    expect(engine.seek).not.toHaveBeenCalled();
    act(() => { callbacks.onPlay?.(); callbacks.onFirstFrame?.("vid-1"); });
    expect(engine.seek).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledTimes(1));
    expect(engine.seek).not.toHaveBeenCalled();
    expect(document.querySelector("main")).not.toHaveClass("is-awaiting-resume-frame");
    // 返回刚看过的集也从头播放，不能重新消费入口续播位置。
    runtime.localLibrary.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 24, durationSeconds: 60 });
    act(() => callbacks.onFirstFrame?.("vid-2"));
    fireEvent.click(screen.getByRole("button", { name: text("player.previousEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledTimes(2));
    expect(engine.seek).not.toHaveBeenCalled();
    expect(document.querySelector("main")).not.toHaveClass("is-awaiting-resume-frame");
  });

  it("暂停和页面退出同步保存不足五秒的进度，账号切换后的旧页 flush 仍归原主体", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined),
      pause: vi.fn(), seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })), destroy: vi.fn(),
    };
    const { runtime, localLibrary: originalLibrary } = createPlayerRuntime(engine);
    const { unmount } = render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );
    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    act(() => callbacks.onTimeUpdate?.({ currentTime: 3, duration: 60, paused: false, ended: false }));
    expect(originalLibrary.recordProgress).not.toHaveBeenCalled();
    act(() => callbacks.onPause?.());
    expect(originalLibrary.recordProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progressSeconds: 3 }));
    act(() => callbacks.onTimeUpdate?.({ currentTime: 6, duration: 60, paused: false, ended: false }));
    fireEvent(window, new Event("pagehide"));
    expect(originalLibrary.recordProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progressSeconds: 6 }));
    const newLibrary = { ...originalLibrary, recordProgress: vi.fn() };
    runtime.localLibrary = newLibrary as unknown as LocalLibraryStore;
    act(() => callbacks.onTimeUpdate?.({ currentTime: 8, duration: 60, paused: false, ended: false }));
    unmount();
    expect(originalLibrary.recordProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progressSeconds: 8 }));
    expect(newLibrary.recordProgress).not.toHaveBeenCalled();
  });

  it("结束事件读取官方最终位置，卸载不覆盖为上一次五秒节流记录", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined),
      pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 60, duration: 60, paused: true, ended: true }),
    };
    const { runtime, localLibrary } = createPlayerRuntime(engine);
    const { unmount } = render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );
    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    act(() => callbacks.onTimeUpdate?.({ currentTime: 55, duration: 60, paused: false, ended: false }));
    act(() => callbacks.onEnded?.());
    expect(localLibrary.recordProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progressSeconds: 60 }));
    unmount();
    expect(localLibrary.recordProgress.mock.calls.map(([input]) => input.progressSeconds)).toEqual([60]);
  });

  it("将 VePlayer 运行时错误映射为友好提示并允许重新获取播放描述符", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => {
        callbacks = nextCallbacks || {};
        return true;
      }),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({
        currentTime: 0,
        duration: 60,
        paused: false,
        ended: false,
      })),
      destroy: vi.fn(),
    };
    const { api, runtime } = createPlayerRuntime(engine);
    runtime.getCachedPublicCatalog = () => ({ dramas: [{ ...drama, coverUrl: "https://images.example/cover.jpg" }] });

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes>
            <Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} />
          </Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    act(() => callbacks.onError?.(new Error("private SDK diagnostic")));

    expect(screen.getByText(text("player.playbackError"))).toBeInTheDocument();
    expect(screen.queryByText("private SDK diagnostic")).not.toBeInTheDocument();

    const currentEpisodeResolveCount = vi.mocked(api.resolvePlay).mock.calls.filter(
      ([, requestedEpisodeId]) => requestedEpisodeId === "episode-1",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
    await waitFor(() => {
      const retriedCurrentEpisodeCount = vi.mocked(api.resolvePlay).mock.calls.filter(
        ([, requestedEpisodeId]) => requestedEpisodeId === "episode-1",
      ).length;
      expect(retriedCurrentEpisodeCount).toBe(currentEpisodeResolveCount + 1);
    });

    act(() => callbacks.onPlay?.());
    expect(screen.queryByText(text("player.playbackError"))).not.toBeInTheDocument();
  });

  it("从顶部返回首页，不重新打开上一集", async () => {
    const engine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const { runtime } = createPlayerRuntime(engine);

    const { container } = render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter
          initialEntries={[
            "/",
            "/watch/drama-1/episode-1",
            "/watch/drama-1/episode-2",
          ]}
          initialIndex={2}
        >
          <Routes>
            <Route path="/" element={<div>Home route</div>} />
            <Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} />
          </Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    const backButton = container.querySelector<HTMLButtonElement>(".player-back-button");
    expect(backButton).not.toBeNull();
    expect(backButton!.closest(".video-swiper-track")).toBeNull();
    expect(backButton!.closest(".theater-content")).not.toBeNull();
    fireEvent.click(backButton!);

    expect(await screen.findByText("Home route")).toBeInTheDocument();
  });

  it("播放页只保留官方选集与倍速入口，并随信息层一起隐藏", async () => {
    const engine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    };
    const { runtime } = createPlayerRuntime(engine);

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    const action = await screen.findByRole("button", { name: text("player.episodeSelector") });
    expect(action).toHaveClass("episode-bar");
    expect(action.parentElement).toHaveClass("player-bottom-controls", "player-chrome");
    expect(screen.queryByRole("button", { name: text("watchlist.add") })).not.toBeInTheDocument();
    expect(within(action).getByText(text("player.episodeProgress", { current: 1, total: drama.episodeCount }))).toBeInTheDocument();
    const rate = screen.getByRole("button", { name: text("player.playbackSpeed", { rate: "1x" }) });
    expect(action.nextElementSibling).toBe(rate);
    expect(screen.queryByRole("button", { name: text("player.shareEpisode") })).not.toBeInTheDocument();
  });

  it("首次起播保留封面到正确首帧，播放中缓冲不闪回封面", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => {
        callbacks = nextCallbacks || {};
        return true;
      }),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    };
    const { api, runtime } = createPlayerRuntime(engine);
    runtime.getCachedPublicCatalog = () => ({ dramas: [{ ...drama, coverUrl: "https://images.example/cover~tplv-vod-noop.image" }] });

    const { container } = render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    expect(api.resolvePlay).toHaveBeenCalledWith("drama-1", "episode-1");
    expect(engine.mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        vid: "vid-1",
        channel: "byteplus",
        albumId: "album-1",
        episodeId: "platform-episode-1",
      }),
      expect.any(Object),
    );
    expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", "https://images.example/cover~tplv-vod-rs:480:0.webp");
    expect(container.querySelector(".player-transition-episode-poster")).not.toBeInTheDocument();

    expect(container.querySelector(".theater-entry-waiting")).not.toBeInTheDocument();
    act(() => callbacks.onFirstFrame?.("vid-other"));
    expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", "https://images.example/cover~tplv-vod-rs:480:0.webp");
    act(() => callbacks.onFirstFrame?.("vid-1"));
    expect(container.querySelector(".player-transition-poster")).not.toBeInTheDocument();
    expect(container.querySelector("main")).toHaveClass("is-media-loading");
    act(() => callbacks.onPlay?.());
    expect(container.querySelector("main")).not.toHaveClass("is-media-loading");
    act(() => callbacks.onBufferingChange?.(true));
    expect(container.querySelector("main")).toHaveClass("is-media-loading");
    expect(container.querySelector(".player-transition-poster")).not.toBeInTheDocument();
    act(() => callbacks.onBufferingChange?.(false));
    expect(container.querySelector("main")).toHaveClass("is-media-loading");
    act(() => callbacks.onPlay?.());
    expect(container.querySelector("main")).not.toHaveClass("is-media-loading");
    expect(container.querySelector(".player-transition-poster")).not.toBeInTheDocument();
  });

  it("正常播放确认早于首帧时仍可点击暂停", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined),
      pause: vi.fn(() => callbacks.onPause?.()), seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 2, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    };
    const { runtime } = createPlayerRuntime(engine);
    const { container } = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());

    act(() => callbacks.onPlay?.());
    expect(container.querySelector("main")).not.toHaveClass("is-media-loading");
    expect(container.querySelector("main")).not.toHaveClass("is-awaiting-resume-frame");
    const stage = screen.getByTestId("player-stage");
    fireEvent.click(stage);
    expect(engine.pause).toHaveBeenCalledOnce();
    expect(stage).toHaveClass("chrome-visible");
  });

  it("自动播放确认前不显示播放器控制层，确认后显示并按时隐藏", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined),
      pause: vi.fn(() => callbacks.onPause?.()), seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    };
    const { runtime } = createPlayerRuntime(engine);
    const { container } = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
    const stage = screen.getByTestId("player-stage");
    expect(stage).not.toHaveClass("chrome-visible");
    expect(container.querySelector("main")).toHaveClass("is-media-loading");

    vi.useFakeTimers();
    act(() => callbacks.onPlay?.());
    expect(stage).toHaveClass("chrome-visible");
    act(() => vi.advanceTimersByTime(2999));
    expect(stage).toHaveClass("chrome-visible");
    act(() => callbacks.onFirstFrame?.("vid-1"));
    // 首帧之后才开始完整的三秒展示窗口，加载等待不消耗控件可见时间。
    act(() => vi.advanceTimersByTime(2999));
    expect(stage).toHaveClass("chrome-visible");
    act(() => vi.advanceTimersByTime(1));
    expect(stage).not.toHaveClass("chrome-visible");
    vi.useRealTimers();
  });

  it("切集不暂停并用目标封面覆盖到首帧，官方进度仍使用同一内核", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => {
        callbacks = nextCallbacks || {};
        return true;
      }),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    };
    const { runtime } = createPlayerRuntime(engine);
    const { container } = render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
    act(() => callbacks.onFirstFrame?.("vid-1"));
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
    expect(engine.pause).not.toHaveBeenCalled();
    expect(container.querySelector("main")).toHaveClass("is-switching");
    expect(container.querySelector('[data-episode-id="episode-2"] .video-slider-poster')).not.toBeInTheDocument();
    expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", "poster.jpg");
    expect(container.querySelector("main")).toHaveClass("is-media-loading");

    act(() => callbacks.onFirstFrame?.("vid-2"));
    expect(container.querySelector("main")).not.toHaveClass("is-switching");
    expect(container.querySelector(".player-transition-poster")).toBeNull();
    expect(container.querySelector("main")).toHaveClass("is-media-loading");
    act(() => callbacks.onPlay?.());
    expect(container.querySelector("main")).not.toHaveClass("is-media-loading");
  });

  it("切到有历史的剧集从头播放，首帧到达不再等待历史位置", async () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
    const library = new LocalLibraryStore("test-app", "visitor-1", storage);
    library.recordProgress({ dramaId: "drama-1", episodeId: "episode-2", episodeNumber: 2, progressSeconds: 24, durationSeconds: 60 });
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
    };
    const { runtime } = createPlayerRuntime(engine);
    runtime.localLibrary = library;
    const { container } = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
    expect(container.querySelector('[data-episode-id="episode-2"] .video-slider-poster')).toHaveAttribute("src", "poster.jpg");
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2", posterUrl: "poster.jpg" })));
    expect(container.querySelector("main")).not.toHaveClass("is-awaiting-resume-frame");
    expect(container.querySelector(".player-transition-poster")).toHaveAttribute("src", "poster.jpg");
    act(() => callbacks.onFirstFrame?.("vid-2"));
    expect(engine.seek).not.toHaveBeenCalled();
    expect(container.querySelector("main")).not.toHaveClass("is-awaiting-resume-frame");
    expect(container.querySelector(".player-transition-poster")).not.toBeInTheDocument();
  });

  it("长剧按 30 集分组，当前集定位及键盘关闭保持正确", async () => {
    const longDrama = dramaWithEpisodes(61);
    const engine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const { runtime } = createPlayerRuntime(engine, longDrama);

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-31"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: text("player.episodeSelector") }));

    expect(screen.getByRole("tab", { name: "1-30" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "31-60" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "61" })).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("button", { name: "Episode 30" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Episode 31, Now playing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Episode 60" })).toBeInTheDocument();

    const rangeTab = screen.getByRole("tab", { name: "31-60" });
    fireEvent.keyDown(rangeTab, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "61" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Episode 31, Now playing" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Episode 61" })).toBeInTheDocument();
    const close = screen.getByRole("button", { name: text("common.close") });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Episode 61" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("button", { name: "Episode 61" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("官方选集入口显示进度，选择下一集仍通过业务验权切换", async () => {
    const engine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const { runtime } = createPlayerRuntime(engine);

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".player-navigation-title")).toBeNull();
    expect(screen.getByText(
      text("player.episodeProgress", { current: 1, total: 3 }),
      { selector: ".theater-copy p" },
    )).toBeInTheDocument();
    expect(screen.getByText("The Last Alibi", { selector: ".theater-copy h1" })).toBeInTheDocument();
    expect(screen.getByText("The message changes everything.", { selector: ".theater-copy p" })).toBeInTheDocument();
    const description = screen.getByText("The message changes everything.").closest(".theater-description");
    expect(description).not.toHaveClass("is-expanded");
    fireEvent.click(screen.getByRole("button", { name: text("player.showMore") }));
    expect(description).toHaveClass("is-expanded");
    fireEvent.click(screen.getByRole("button", { name: text("player.showLess") }));
    expect(description).not.toHaveClass("is-expanded");
    fireEvent.click(screen.getByRole("button", { name: text("player.episodeSelector") }));
    const episodeTwo = screen.getByRole("button", { name: "Episode 2" });
    expect(episodeTwo).toHaveTextContent(/^2$/);
    fireEvent.click(episodeTwo);
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(
      expect.objectContaining({ vid: "vid-2" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: text("player.episodeSelector") }));
    expect(screen.getByRole("button", { name: "Episode 2, Now playing" })).toBeInTheDocument();
  });

  it("打开选集抽屉时保留当前播放器实例和播放状态", async () => {
    const engine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 12, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const { runtime } = createPlayerRuntime(engine);

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: text("player.episodeSelector") }));

    expect(document.querySelector(".theater-page")).toHaveClass("is-episode-drawer-open");
    expect(screen.getByRole("dialog", { name: text("player.episodeSelector") })).toBeInTheDocument();
    expect(engine.pause).not.toHaveBeenCalled();
    expect(engine.destroy).not.toHaveBeenCalled();
  });

  it("点击倍速按钮直接进入下一档且选集仍清晰标记激励解锁剧集", async () => {
    const engine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      setPlaybackRate: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const lockedDrama: DramaDetail = {
      ...drama,
      episodes: drama.episodes.map((episode) => ({
        ...episode,
        accessMode: episode.number === 2 ? "rewarded" : episode.number === 3 ? "unlocked" : "free",
      })),
    };
    const { runtime } = createPlayerRuntime(engine, lockedDrama);

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    expect(engine.setPlaybackRate).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1x" }));
    expect(engine.setPlaybackRate).toHaveBeenLastCalledWith(1.25);
    expect(screen.queryByRole("dialog", { name: text("player.playbackSpeedOptions") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Playback speed, 1.25x" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed, 1.25x" }));
    expect(engine.setPlaybackRate).toHaveBeenLastCalledWith(1.5);
    expect(screen.getByRole("button", { name: "Playback speed, 1.5x" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: text("player.episodeSelector") }));
    const episodeSheet = screen.getByRole("dialog", { name: text("player.episodeSelector") });
    expect(within(episodeSheet).getByRole("heading", { name: lockedDrama.title })).toBeInTheDocument();
    expect(within(episodeSheet).getByText(text("drama.episodeCount", { count: lockedDrama.episodeCount }))).toBeInTheDocument();
    expect(episodeSheet.querySelector(".episode-sheet-cover")).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: text("player.playbackPosition") })).not.toBeInTheDocument();
    expect(screen.getByText(/watch an ad to unlock marked episodes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /episode 2.*watch ad to unlock/i })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /watch ad to unlock/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Episode 3" })).toBeInTheDocument();
  });

  it("播放画面长按临时 2x，松开恢复 1x", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine = {
      mount: vi.fn(async (_root, _source, next) => { callbacks = next || {}; return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined), pause: vi.fn(), seek: vi.fn(),
      setPlaybackRate: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: false, ended: false })), destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const { runtime } = createPlayerRuntime(engine);
    render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
      <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
    </MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
    act(() => callbacks.onPlay?.());
    const stage = screen.getByTestId("player-stage");
    vi.useFakeTimers();
    try {
      const down = new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 });
      Object.defineProperties(down, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
      fireEvent(stage, down);
      act(() => vi.advanceTimersByTime(350));
      expect(engine.setPlaybackRate).toHaveBeenLastCalledWith(2);
      // 临时倍速不重渲染播放页常规倍速入口。
      expect(screen.getByRole("button", { name: "Playback speed, 1x" })).toBeInTheDocument();
      fireEvent.pointerUp(window);
      expect(engine.setPlaybackRate).toHaveBeenLastCalledWith(1);
      expect(screen.getByRole("button", { name: "Playback speed, 1x" })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("当前集结束后直接切换下一集，不显示倒计时弹窗", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => {
        callbacks = nextCallbacks || {};
        return true;
      }),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 60, duration: 60, paused: true, ended: true })),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const { runtime } = createPlayerRuntime(engine);

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    act(() => callbacks.onEnded?.());

    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(
      expect.objectContaining({ vid: "vid-2" }),
    ));
    expect(screen.queryByText("Up next")).not.toBeInTheDocument();
  });

  it("把当前集字符串参数注册到官方菜单，不提供无法主动唤起原生面板的自绘按钮", async () => {
    const engine: PlaybackEngine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    };
    const share = vi.fn(async () => ({ status: "success" as const }));
    const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      drama: vi.fn(async () => drama),
      resolvePlay: vi.fn(async (): Promise<PlayResolveResult> => ({
        status: "playable",
        drama,
        episode: drama.episodes[0],
        playback: playbackFor(drama.episodes[0]),
      })),
    } as unknown as MiniDramaApi;
    const runtime = {
      getVisitorID: () => "visitor-1",
      api,
      createPlaybackEngine: () => engine,
      share,
      registerShare: vi.fn(() => () => undefined),
      ...runtimeAdExperience,
    } as unknown as Runtime;

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalled());
    await waitFor(() => expect(runtime.registerShare).toHaveBeenCalledWith(expect.objectContaining({
      desc: "The message changes everything.",
      query: { dramaId: "drama-1", episodeId: "episode-1", tt_album_id: "album-1", tt_episode_id: "platform-episode-1" },
    }), expect.any(Function)));
    expect(share).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: text("player.shareEpisode") })).not.toBeInTheDocument();
  });

  it("stores local progress for the new episode after playNext", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(() => callbacks.onPause?.()),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    };
    const localLibrary = {
      isFollowing: vi.fn(() => false),
      setFollow: vi.fn(),
      recordProgress: vi.fn(),
    };
    const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      drama: vi.fn(async () => drama),
      resolvePlay: vi.fn(async (_dramaId: string, episodeId: string): Promise<PlayResolveResult> => {
        const episode = drama.episodes.find((item) => item.id === episodeId)!;
        return {
          status: "playable",
          drama,
          episode,
          playback: playbackFor(episode),
        };
      }),
    } as unknown as MiniDramaApi;
    const runtime = {
      getVisitorID: () => "visitor-1",
      api,
      bootstrap: vi.fn(async () => undefined),
      createPlaybackEngine: () => engine,
      showRewardedAd: vi.fn(),
      claimReward: vi.fn(),
      localLibrary,
      ...runtimeAdExperience,
    } as unknown as Runtime;

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    const stage = screen.getByTestId("player-stage");
    const page = stage.closest(".theater-page")!;
    expect(document.querySelector(".episode-arrows")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: text("player.nextEpisode") }),
    ).toHaveClass("sr-only");

    vi.useFakeTimers();
    act(() => callbacks.onPlay?.());
    expect(stage).toHaveClass("chrome-visible");
    // PLAYING 先于首帧，慢加载不能消耗用户看到控件的三秒窗口。
    act(() => vi.advanceTimersByTime(5000));
    expect(stage).toHaveClass("chrome-visible");
    act(() => callbacks.onFirstFrame?.("vid-1"));
    act(() => vi.advanceTimersByTime(2999));
    expect(stage).toHaveClass("chrome-visible");
    act(() => vi.advanceTimersByTime(1));
    expect(stage).not.toHaveClass("chrome-visible");
    // 有效拖动期间不消耗无操作时间；松手后重新显示完整信息三秒。
    act(() => callbacks.onSeekingChange?.(true));
    expect(stage).toHaveClass("chrome-visible");
    expect(page).toHaveClass("is-seeking");
    act(() => vi.advanceTimersByTime(5000));
    expect(stage).toHaveClass("chrome-visible");
    act(() => callbacks.onSeekingChange?.(false));
    expect(page).not.toHaveClass("is-seeking");
    act(() => vi.advanceTimersByTime(2999));
    expect(stage).toHaveClass("chrome-visible");
    act(() => vi.advanceTimersByTime(1));
    expect(stage).not.toHaveClass("chrome-visible");
    // 长按加速也暂停计时，只保留进度条，松手后再计完整三秒。
    fireEvent.pointerDown(stage, { pointerId: 41, pointerType: "touch", clientX: 100, clientY: 100 });
    act(() => vi.advanceTimersByTime(350));
    expect(stage).toHaveClass("is-speeding", "chrome-visible");
    act(() => vi.advanceTimersByTime(5000));
    expect(stage).toHaveClass("chrome-visible");
    fireEvent.pointerUp(window, { pointerId: 41, pointerType: "touch", clientX: 100, clientY: 100 });
    expect(stage).not.toHaveClass("is-speeding");
    act(() => vi.advanceTimersByTime(2999));
    expect(stage).toHaveClass("chrome-visible");
    act(() => vi.advanceTimersByTime(1));
    expect(stage).not.toHaveClass("chrome-visible");
    fireEvent.click(stage);
    act(() => vi.advanceTimersByTime(3000));
    expect(stage).not.toHaveClass("chrome-visible");
    fireEvent.click(stage);
    expect(stage).toHaveClass("chrome-visible");
    expect(engine.pause).not.toHaveBeenCalled();
    fireEvent.click(stage);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(stage).toHaveClass("chrome-visible");
    fireEvent.click(stage);
    expect(engine.play).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    finishNextSlide(stage);
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledTimes(1));
    expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({
      vid: "vid-2",
      albumId: "album-1",
      episodeId: "platform-episode-2",
    }));
    act(() => callbacks.onTimeUpdate?.({ currentTime: 6, duration: 60, paused: false, ended: false }));
    await waitFor(() => expect(localLibrary.recordProgress).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-2" })));
  });

  it("does not block source switching after a local progress write", async () => {
    let callbacks: PlaybackCallbacks = {};
    const localLibrary = {
      isFollowing: vi.fn(() => false),
      setFollow: vi.fn(),
      recordProgress: vi.fn(),
    };
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 6, duration: 60, paused: false, ended: false })),
      destroy: vi.fn(),
    };
    const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      drama: vi.fn(async () => drama),
      resolvePlay: vi.fn(async (_dramaId: string, episodeId: string): Promise<PlayResolveResult> => {
        const episode = drama.episodes.find((item) => item.id === episodeId)!;
        return { status: "playable", drama, episode, playback: playbackFor(episode) };
      }),
    } as unknown as MiniDramaApi;
    const runtime = {
      getVisitorID: () => "visitor-1",
      api,
      bootstrap: vi.fn(async () => undefined),
      createPlaybackEngine: () => engine,
      showRewardedAd: vi.fn(),
      claimReward: vi.fn(),
      localLibrary,
      ...runtimeAdExperience,
    } as unknown as Runtime;

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    act(() => callbacks.onTimeUpdate?.({ currentTime: 6, duration: 60, paused: false, ended: false }));
    await waitFor(() => expect(localLibrary.recordProgress).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledTimes(1));
  });

  it("does not assign delayed switch events to a newer episode", async () => {
    let callbacks: PlaybackCallbacks = {};
    const pending = new Map<string, () => void>();
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks = nextCallbacks || {}; return true; }),
      switchSource: vi.fn((source) => new Promise<void>((resolve) => pending.set(source.vid, resolve))),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    };
    const localLibrary = {
      isFollowing: vi.fn(() => false),
      setFollow: vi.fn(),
      recordProgress: vi.fn(),
    };
    const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      drama: vi.fn(async () => drama),
      resolvePlay: vi.fn(async (_dramaId: string, episodeId: string): Promise<PlayResolveResult> => {
        const episode = drama.episodes.find((item) => item.id === episodeId)!;
        return { status: "playable", drama, episode, playback: playbackFor(episode) };
      }),
    } as unknown as MiniDramaApi;
    const runtime = {
      getVisitorID: () => "visitor-1",
      api,
      bootstrap: vi.fn(async () => undefined),
      createPlaybackEngine: () => engine,
      showRewardedAd: vi.fn(),
      claimReward: vi.fn(),
      localLibrary,
      ...runtimeAdExperience,
    } as unknown as Runtime;

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-3" })));

    await act(async () => { pending.get("vid-2")?.(); });
    await act(async () => { pending.get("vid-3")?.(); });
    act(() => callbacks.onTimeUpdate?.({ currentTime: 6, duration: 60, paused: false, ended: false }));

    await waitFor(() => expect(localLibrary.recordProgress).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-3" })));
    expect(localLibrary.recordProgress).not.toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-2" }));
  });

  it("投放落地的锁定集只提供逐集解锁，不自动打开 VIP 广告", async () => {
    const lockedEpisode = drama.episodes[0];
    const engine = {
      mount: vi.fn(async () => true),
      destroy: vi.fn(),
    } as unknown as PlaybackEngine;
    const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      drama: vi.fn(async () => drama),
      resolvePlay: vi.fn(async (): Promise<PlayResolveResult> => ({
        status: "access_required",
        drama,
        episode: lockedEpisode,
        offer: { offerId: "episode-offer", adUnitId: "episode-placement", kind: "rewarded_episode" },
        vipOffer: { offerId: "vip-offer", adUnitId: "vip-placement", kind: "rewarded_vip" },
      })),
    } as unknown as MiniDramaApi;
    const campaignExperience = enabledVIPExperience;
    const runtime = {
      getVisitorID: () => "visitor-1",
      api,
      createPlaybackEngine: () => engine,
      getAdExperience: () => campaignExperience,
      subscribeAdExperience: () => () => undefined,
      watchVIPAd: vi.fn(),
    } as unknown as Runtime;

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: text("player.watchToUnlock") })).toBeInTheDocument());
    expect(runtime.watchVIPAd).not.toHaveBeenCalled();
    expect(engine.mount).not.toHaveBeenCalled();
  });

  it("自动广告结算晚于切集时不刷新已离开的剧集", async () => {
    let finishClaim: (value: ClaimResult) => void = () => undefined;
    const claim = new Promise<ClaimResult>((resolve) => {
      finishClaim = resolve;
    });
    const engine: PlaybackEngine = {
      mount: vi.fn(async () => true),
      switchSource: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 0, duration: 60, paused: true, ended: false })),
      destroy: vi.fn(),
    };
    const resolvePlay = vi.fn(async (_dramaId: string, episodeId: string): Promise<PlayResolveResult> => {
      const episode = drama.episodes.find((item) => item.id === episodeId)!;
      if (episodeId === "episode-1") {
        return {
          status: "access_required",
          drama,
          episode,
          offer: {
            offerId: "episode-offer-1",
            adUnitId: "placement-1",
            kind: "rewarded_episode",
          },
        };
      }
      return {
        status: "playable",
        drama,
        episode,
        playback: playbackFor(episode),
      };
    });
    const api = {
    entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      drama: vi.fn(async () => drama),
      resolvePlay,
    } as unknown as MiniDramaApi;
    const runtime = {
      getVisitorID: () => "visitor-1",
      api,
      bootstrap: vi.fn(async () => undefined),
      createPlaybackEngine: () => engine,
      showRewardedAd: vi.fn(async () => ({ status: "completed" as const })),
      claimReward: vi.fn(() => claim),
      ...runtimeAdExperience,
      getAdExperience: () => enabledEpisodeAdExperience,
    } as unknown as Runtime;

    render(
      <RuntimeContext.Provider value={runtime}>
        <MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
          <Link to="/watch/drama-1/episode-2">切至第二集</Link>
          <Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes>
        </MemoryRouter>
      </RuntimeContext.Provider>,
    );

    await waitFor(() => expect(runtime.claimReward).toHaveBeenCalledOnce());
    expect(runtime.showRewardedAd).toHaveBeenCalledOnce();

    expect(runtime.claimReward).toHaveBeenCalledWith(expect.objectContaining({
      offerId: "episode-offer-1",
      adUnitId: "placement-1",
      dramaId: "drama-1",
      episodeId: "episode-1",
      claimId: expect.stringMatching(/^claim_[0-9a-f]{32}$/),
    }));
    fireEvent.click(screen.getByRole("link", { name: "切至第二集" }));
    await waitFor(() => expect(resolvePlay).toHaveBeenCalledWith("drama-1", "episode-2"));
    expect(engine.mount).not.toHaveBeenCalled();
    await act(async () => {
      finishClaim({ unlocked: true, status: "granted", claimId: "claim-episode-0001", dramaId: "drama-1", episodeId: "episode-1", rewardType: "episode_unlock" });
      await claim;
    });
    await waitFor(() => expect(engine.mount).toHaveBeenCalled());

    await waitFor(() => expect(resolvePlay).toHaveBeenCalledWith(
      "drama-1",
      "episode-2",
    ));
    expect(resolvePlay.mock.calls.filter((call) => call[1] === "episode-1")).toHaveLength(1);
  });
});


it("首集锁定时先预加载媒体，服务端未确认可播前不挂载播放器", async () => {
  const engine = {
    mount: vi.fn(async () => true), switchSource: vi.fn(async () => {}),
    play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  } as PlaybackEngine;
  const { api, runtime } = createPlayerRuntime(engine);
  vi.mocked(api.resolvePlay).mockResolvedValue({
    status: "access_required", drama, episode: drama.episodes[0], preload: playbackFor(drama.episodes[0]),
    offer: { offerId: "offer-1", adUnitId: "ad-1", kind: "rewarded_episode" },
  });
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.showRewardedAd = vi.fn(() => new Promise<Awaited<ReturnType<Runtime["showRewardedAd"]>>>(() => {}));
  const { container } = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([expect.objectContaining({ vid: "vid-1" })], 0));
  expect(container.querySelector(".player-transition-poster")).not.toBeInTheDocument();
  expect(engine.mount).not.toHaveBeenCalled();
  expect(engine.switchSource).not.toHaveBeenCalled();
});

it("相邻锁定集进入官方 Feed 预加载，但手动切集仍停在领奖门禁", async () => {
  let callbacks: PlaybackCallbacks = {};
  const detail = dramaWithEpisodes(3);
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  };
  const { api, runtime } = createPlayerRuntime(engine, detail);
  vi.mocked(api.resolvePlay).mockImplementation(async (_dramaId, id) => {
    const episode = detail.episodes.find(item => item.id === id)!;
    return id === "episode-2"
      ? { status: "access_required", drama: detail, episode, preload: playbackFor(episode), offer: { offerId: "offer-2", adUnitId: "ad-1", kind: "rewarded_episode" } }
      : { status: "playable", drama: detail, episode, playback: playbackFor(episode) };
  });
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.showRewardedAd = vi.fn(() => new Promise<Awaited<ReturnType<Runtime["showRewardedAd"]>>>(() => {}));
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
  act(() => callbacks.onFirstFrame?.("vid-1"));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([
    expect.objectContaining({ vid: "vid-1" }), expect.objectContaining({ vid: "vid-2" }), expect.objectContaining({ vid: "vid-3" }),
  ], 1));
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(runtime.showRewardedAd).toHaveBeenCalled());
  expect(engine.switchSource).not.toHaveBeenCalled();
});

it("当前集首帧前保留入口预热，出画后提交连续可预热候选", async () => {
  let callbacks: PlaybackCallbacks = {};
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  };
  const { runtime } = createPlayerRuntime(engine, dramaWithEpisodes(5));
  const originalResolve = runtime.api.resolvePlay;
  runtime.api.resolvePlay = vi.fn(async (id, episodeId) => episodeId === "episode-3" ? { status: "unavailable" as const } : originalResolve(id, episodeId));
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.clearMediaPreload = vi.fn();
  const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalledWith("drama-1", "episode-3"));
  expect(runtime.api.resolvePlay).not.toHaveBeenCalledWith("drama-1", "episode-4");
  expect(runtime.api.resolvePlay).not.toHaveBeenCalledWith("drama-1", "episode-5");
  expect(engine.mount).toHaveBeenCalledOnce();
  expect(runtime.preloadMedia).not.toHaveBeenCalled();
  act(() => callbacks.onFirstFrame?.("vid-other"));
  expect(runtime.preloadMedia).not.toHaveBeenCalled();
  act(() => callbacks.onFirstFrame?.("vid-1"));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenLastCalledWith([
    expect.objectContaining({ vid: "vid-1" }), expect.objectContaining({ vid: "vid-2" }),
  ], 1));
  expect(runtime.clearMediaPreload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name:text("player.nextEpisode")}));
  await waitFor(() => expect(engine.switchSource).toHaveBeenLastCalledWith(expect.objectContaining({vid:"vid-2"})));
  fireEvent.click(screen.getByRole("button", {name:text("player.previousEpisode")}));
  await waitFor(() => expect(engine.switchSource).toHaveBeenLastCalledWith(expect.objectContaining({vid:"vid-1"})));
  expect(runtime.clearMediaPreload).not.toHaveBeenCalled();
  view.unmount();
  expect(runtime.clearMediaPreload).toHaveBeenCalled();
});

it("主流程：首帧 -> 批量验权预加载 -> 切集复用结果", async () => {
  let callbacks: PlaybackCallbacks = {};
  const detail = dramaWithEpisodes(5);
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  };
  const { runtime } = createPlayerRuntime(engine, detail);
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.resolvePlaybackBatch = vi.fn(async (_dramaId: string, episodeIds: string[]) => episodeIds.map((id: string) => {
    const episode = detail.episodes.find(item => item.id === id)!;
    return { status: "playable" as const, drama: detail, episode, playback: playbackFor(episode) };
  }));

  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);

  await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce());
  expect(runtime.resolvePlaybackBatch).toHaveBeenCalledWith("drama-1", ["episode-2", "episode-3"]);
  act(() => callbacks.onFirstFrame?.("vid-1"));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenLastCalledWith([
    expect.objectContaining({ vid: "vid-1" }),
    expect.objectContaining({ vid: "vid-2" }),
    expect.objectContaining({ vid: "vid-3" }),
  ], 1));
  // 同轮已完成授权必须合并发布，不能先缩成当前集再逐项替换官方列表。
  expect(runtime.preloadMedia).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
  await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(2));
  expect(vi.mocked(runtime.resolvePlaybackBatch!).mock.calls[1]).toEqual(["drama-1", ["episode-4"]]);
});

it("播放中段持续刷新过期相邻授权，暂停不刷新且切集复用新结果", async () => {
  let callbacks: PlaybackCallbacks = {};
  let now = 1_000;
  const dateNow = vi.spyOn(performance, "now").mockImplementation(() => now);
  const detail = dramaWithEpisodes(3);
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
  };
  const { api, runtime } = createPlayerRuntime(engine, detail);
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.resolvePlaybackBatch = vi.fn(async (_dramaId: string, episodeIds: string[]) => episodeIds.map((id: string) => {
    const episode = detail.episodes.find(item => item.id === id)!;
    return { status: "playable" as const, drama: detail, episode, playback: playbackFor(episode) };
  }));

  try {
    render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce());
    now += 20_001;
    act(() => callbacks.onTimeUpdate?.({ currentTime: 21, duration: 60, paused: true, ended: false }));
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce();
    await act(async () => {
      callbacks.onTimeUpdate?.({ currentTime: 21, duration: 60, paused: false, ended: false });
      callbacks.onTimeUpdate?.({ currentTime: 22, duration: 60, paused: false, ended: false });
    });
    await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runtime.resolvePlaybackBatch!).mock.calls[1]).toEqual(["drama-1", ["episode-2"]]);

    now += 20_001;
    act(() => callbacks.onTimeUpdate?.({ currentTime: 41, duration: 60, paused: false, ended: false }));
    await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
    expect(vi.mocked(api.resolvePlay).mock.calls.filter((call) => call[1] === "episode-2")).toHaveLength(0);
  } finally {
    dateNow.mockRestore();
  }
});

it("相邻刷新慢请求不重叠，失败记录实际错误且撤权结果不能继续播放", async () => {
  let callbacks: PlaybackCallbacks = {};
  let now = 1_000;
  const dateNow = vi.spyOn(performance, "now").mockImplementation(() => now);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let rejectRefresh!: (reason: Error) => void;
  const detail = dramaWithEpisodes(3);
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 21, duration: 120, paused: false, ended: false }),
  };
  const { runtime } = createPlayerRuntime(engine, detail);
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.resolvePlaybackBatch = vi.fn(async (_dramaId: string, ids: string[]): Promise<PlayResolveResult[]> => ids.map(id => {
    const episode = detail.episodes.find(item => item.id === id)!;
    return { status: "playable", drama: detail, episode, playback: playbackFor(episode) };
  }));
  const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  const tick = () => callbacks.onTimeUpdate?.({ currentTime: 21, duration: 120, paused: false, ended: false });
  try {
    await waitFor(() => expect(runtime.resolvePlaybackBatch).toHaveBeenCalledOnce());
    vi.mocked(runtime.resolvePlaybackBatch).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    now += 20_001;
    act(tick);
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(2);
    now += 20_001;
    act(tick);
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(2);
    await act(async () => rejectRefresh(new Error("Adjacent request timed out")));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "adjacent_playback_refresh_failed", error: "Adjacent request timed out",
    }));
    vi.mocked(runtime.resolvePlaybackBatch).mockResolvedValueOnce([{ status: "unavailable" }]);
    await act(async () => { tick(); tick(); });
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(3);
    act(tick);
    expect(runtime.resolvePlaybackBatch).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(engine.destroy).toHaveBeenCalled());
    expect(engine.switchSource).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    dateNow.mockRestore();
    warn.mockRestore();
  }
});

it("慢邻集不阻塞起播，自动预加载不跨过未授权缺口", async () => {
  let callbacks: PlaybackCallbacks = {};
  let resolveSecond!: (value: PlayResolveResult) => void;
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  };
  const { runtime } = createPlayerRuntime(engine, dramaWithEpisodes(4));
  const originalResolve = runtime.api.resolvePlay;
  runtime.api.resolvePlay = vi.fn((id, episodeId) => episodeId === "episode-2"
    ? new Promise<PlayResolveResult>((resolve) => { resolveSecond = resolve; })
    : originalResolve(id, episodeId));
  runtime.preloadMedia = vi.fn(async () => {});
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
  act(() => callbacks.onFirstFrame?.("vid-1"));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([
    expect.objectContaining({ vid: "vid-1" }),
  ], 1));
  act(() => resolveSecond({ status: "playable", drama: dramaWithEpisodes(4), episode: dramaWithEpisodes(4).episodes[1], playback: playbackFor(dramaWithEpisodes(4).episodes[1]) }));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenLastCalledWith([
    expect.objectContaining({ vid: "vid-1" }), expect.objectContaining({ vid: "vid-2" }), expect.objectContaining({ vid: "vid-3" }),
  ], 1));
});

it("授权就绪即起播，慢详情随后补齐且不重建播放器", async () => {
  const engine = {
    mount: vi.fn(async () => true), switchSource: vi.fn(async () => {}),
    play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
  } as PlaybackEngine;
  const { api, runtime } = createPlayerRuntime(engine);
  let finish!: (value: DramaDetail) => void;
  vi.mocked(api.drama).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  runtime.resolvePlayback = vi.fn(async (): Promise<PlayResolveResult> => ({ status: "playable", drama, episode: drama.episodes[0], playback: playbackFor(drama.episodes[0]) }));
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
  expect(runtime.resolvePlayback).toHaveBeenCalledWith("drama-1", "episode-1");
  expect(api.resolvePlay).not.toHaveBeenCalled();
  const root = vi.mocked(engine.mount).mock.calls[0][0];
  expect(root.isConnected).toBe(true);
  await act(async () => finish(drama));
  expect(engine.mount).toHaveBeenCalledOnce();
  expect(engine.switchSource).not.toHaveBeenCalled();
  expect(root.isConnected).toBe(true);
  expect(screen.getByRole("button", { name: text("player.nextEpisode") })).toBeEnabled();
});

// 使用真实页面和受控播放器事件验证路由、生命周期及许可缓存之间的交接。
function playbackRegressionHarness() {
  let callbacks: PlaybackCallbacks = {};
  let paused = false;
  const engine: PlaybackEngine = {
    mount: vi.fn(async (_root, _source, value) => { callbacks = value || {}; return true; }),
    switchSource: vi.fn(async () => {}),
    play: vi.fn(async () => { paused = false; callbacks.onPlay?.(); }),
    pause: vi.fn(() => { paused = true; callbacks.onPause?.(); }),
    seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 10, duration: 60, paused, ended: false }),
  };
  const { api, runtime, localLibrary } = createPlayerRuntime(engine);
  runtime.preloadMedia = vi.fn(async () => {});
  runtime.clearMediaPreload = vi.fn();
  runtime.reportPlaybackEvent = vi.fn();
  runtime.reportPlaybackComplete = vi.fn();
  const mount = () => render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  return { engine, api, runtime, localLibrary, mount, events: () => callbacks };
}

it("已有入口授权时等入剧门禁放行即可挂载，完整目录继续并行", async () => {
  const h = playbackRegressionHarness();
  const episode = drama.episodes[0];
  const play = { status: "playable" as const, drama, episode, playback: playbackFor(episode) };
  h.runtime.getCachedPlayable = vi.fn(() => play);
  let releaseGate!: () => void;
  vi.mocked(h.api.entryAdStatus).mockImplementationOnce(() => new Promise(resolve => {
    releaseGate = () => resolve({ enabled: false, completedCount: 0, requiredCount: 0 });
  }));
  vi.mocked(h.api.drama).mockImplementation(() => new Promise(() => {}));
  h.mount();
  expect(h.engine.mount).not.toHaveBeenCalled();
  await act(async () => releaseGate());
  expect(h.engine.mount).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ vid: "vid-1" }), expect.anything());
  expect(h.api.drama).toHaveBeenCalledOnce();
  expect(h.api.resolvePlay).not.toHaveBeenCalled();
});

it("新路由等待许可时拒收旧集首帧、播放、结束和进度事件", async () => {
  const h = playbackRegressionHarness();
  let resolveNext!: (value: PlayResolveResult) => void;
  const original = h.api.resolvePlay;
  h.api.resolvePlay = vi.fn((id, episode) => episode === "episode-2"
    ? new Promise<PlayResolveResult>(resolve => { resolveNext = resolve; }) : original(id, episode));
  const view = h.mount();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(h.api.resolvePlay).toHaveBeenCalledWith("drama-1", "episode-2"));
  vi.mocked(h.runtime.reportPlaybackEvent!).mockClear();
  act(() => {
    h.events().onFirstFrame?.("vid-1");
    h.events().onPlay?.();
    h.events().onEnded?.();
    h.events().onTimeUpdate?.({ currentTime: 55, duration: 60, paused: false, ended: false });
  });
  expect(h.runtime.reportPlaybackEvent).not.toHaveBeenCalled();
  expect(h.runtime.reportPlaybackComplete).not.toHaveBeenCalled();
  expect(h.localLibrary.recordProgress).not.toHaveBeenCalled();
  expect(view.container.querySelector("main")).toHaveClass("is-switching");
  expect(view.container.querySelector(".player-transition-poster")).toHaveAttribute("src", "poster.jpg");
  await act(async () => resolveNext({ status: "playable", drama, episode: drama.episodes[1], playback: playbackFor(drama.episodes[1]) }));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledOnce());
  expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ posterUrl: drama.episodes[1].posterUrl }));
  expect(view.container.querySelector(".player-transition-poster")).toHaveAttribute("src", "poster.jpg");
  act(() => h.events().onPlay?.());
  expect(h.runtime.reportPlaybackEvent).toHaveBeenCalledWith("ep_play", expect.anything(), "episode-2");
});

it("相邻集请求拒绝后仍预加载成功候选", async () => {
  const h = playbackRegressionHarness();
  const original = h.api.resolvePlay;
  h.api.resolvePlay = vi.fn((id, episode) => episode === "episode-3"
    ? Promise.reject(new Error("permission request failed")) : original(id, episode));
  h.mount();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  act(() => h.events().onFirstFrame?.("vid-1"));
  await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenCalledWith([
    expect.objectContaining({ vid: "vid-1" }), expect.objectContaining({ vid: "vid-2" }),
  ], 1));
});

it("回前台直接安装撤权结果，不重新消费旧的 runtime 许可", async () => {
  const h = playbackRegressionHarness();
  const listeners = new Map<string, () => void>();
  const previous = window.TTMinis;
  window.TTMinis = { on: (event: string, callback: () => void) => { listeners.set(event, callback); return event; }, off: vi.fn() } as unknown as NonNullable<typeof window.TTMinis>;
  const cached = { status: "playable" as const, drama, episode: drama.episodes[0], playback: playbackFor(drama.episodes[0]) };
  h.runtime.resolvePlayback = vi.fn(async () => cached);
  h.runtime.invalidatePlayback = vi.fn();
  const view = h.mount();
  try {
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    act(() => h.events().onPlay?.());
    act(() => listeners.get("minis.hide")!());
    vi.mocked(h.api.resolvePlay).mockResolvedValue({ status: "unavailable" });
    vi.mocked(h.runtime.resolvePlayback).mockClear();
    act(() => listeners.get("minis.show")!());
    await screen.findByText(text("player.openError"));
    expect(h.runtime.invalidatePlayback).toHaveBeenCalledOnce();
    await waitFor(() => expect(h.engine.destroy).toHaveBeenCalled());
    expect(h.engine.play).not.toHaveBeenCalled();
    expect(h.runtime.resolvePlayback).not.toHaveBeenCalledWith("drama-1", "episode-1");
  } finally { view.unmount(); window.TTMinis = previous; }
});

it("临时后台保留 Feed 预加载，返回后刷新候选并在完播时直接切集", async () => {
  const h = playbackRegressionHarness();
  const listeners = new Map<string, () => void>();
  const previous = window.TTMinis;
  window.TTMinis = { on: (event: string, callback: () => void) => { listeners.set(event, callback); return event; }, off: vi.fn() } as unknown as NonNullable<typeof window.TTMinis>;
  const view = h.mount();
  try {
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    act(() => h.events().onFirstFrame?.("vid-1"));
    await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenCalled());
    vi.mocked(h.runtime.clearMediaPreload!).mockClear();
    act(() => listeners.get("minis.hide")!());
    expect(h.runtime.clearMediaPreload).not.toHaveBeenCalled();
    vi.mocked(h.runtime.preloadMedia!).mockClear();
    act(() => listeners.get("minis.show")!());
    await waitFor(() => expect(h.runtime.preloadMedia).toHaveBeenCalled());
    act(() => h.events().onEnded?.());
    await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
  } finally { view.unmount(); window.TTMinis = previous; }
});

it("快速切走再返回同一个缓存许可仍重新接通播放事件", async () => {
  const h = playbackRegressionHarness();
  const cached = { status: "playable" as const, drama, episode: drama.episodes[0], playback: playbackFor(drama.episodes[0]) };
  h.runtime.resolvePlayback = vi.fn((_id, episode) => episode === "episode-1"
    ? Promise.resolve(cached) : new Promise<PlayResolveResult>(() => {}));
  h.mount();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(h.runtime.resolvePlayback).toHaveBeenCalledWith("drama-1", "episode-2"));
  fireEvent.click(screen.getByRole("button", { name: text("player.previousEpisode") }));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-1" })));
  act(() => h.events().onPlay?.());
  expect(h.runtime.reportPlaybackEvent).toHaveBeenCalledWith("ep_play", expect.anything(), "episode-1");
});

it.each([false, true])("进入短剧取得详情后更新已有摘要，不新增历史或改变进度，已有记录=%s", async recorded => {
  const values = new Map<string, string>();
  const library = new LocalLibraryStore("app", "viewer", { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  if (recorded) library.recordProgress({ dramaId: drama.id, episodeId: drama.firstEpisodeId, episodeNumber: 1, progressSeconds: 17, durationSeconds: 60, drama: { ...drama, title: "Old title" } });
  const before = library.history()[0];
  const { runtime, api } = createPlayerRuntime({} as PlaybackEngine);
  Object.defineProperty(runtime, "localLibrary", { value: library });
  // 播放授权尚未返回，证明摘要更新不依赖实际起播和进度回调。
  vi.mocked(api.resolvePlay).mockImplementation(() => new Promise(() => {}));
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
  await act(async () => {});
  expect(api.drama).toHaveBeenCalledWith(drama.id);
  if (recorded) {
    expect(library.history()[0]).toMatchObject({ progressSeconds: 17, updatedAt: before.updatedAt, drama: { title: drama.title } });
  } else expect(library.history()).toEqual([]);
});

describe("独立播放器授权恢复", () => {
  const directResult = (episodeId = "episode-1"): PlayResolveResult => {
    const episode = drama.episodes.find(item => item.id === episodeId)!;
    return new ServerClock().bind<PlayResolveResult>({ status: "playable", drama, episode, playback: { ...playbackFor(episode), albumId: undefined, episodeId: undefined, provider: "byteplus_web", playAuthToken: "test-temporary-authorization", expiresAt: new Date(Date.now() + 60_000).toISOString() } }, new Date().toISOString(), performance.now(), 0, 0);
  };
  // 回归夹具保留同一内核的挂载回调，模拟真实 SDK 切源时不替换业务回调的行为。
  const recoveryHarness = (configure?: (runtime: Runtime) => void) => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, next) => { callbacks = next || {}; return true; }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: vi.fn(() => ({ currentTime: 10, duration: 60, paused: false, ended: false })),
    };
    const { runtime, api, localLibrary } = createPlayerRuntime(engine);
    runtime.invalidatePlayback = vi.fn();
    vi.mocked(api.resolvePlay).mockImplementation(async (_drama, id) => directResult(id));
    configure?.(runtime);
    const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    return { engine, runtime, api, localLibrary, view, events: () => callbacks };
  };
  // 只在测试中提供 Minis 生命周期信号，退出后还原 SDK，避免污染其他播放和广告用例。
  const visibilityHarness = (configure?: (runtime: Runtime) => void) => {
    const listeners = new Map<string, () => void>();
    const previousSDK = window.TTMinis;
    window.TTMinis = { on: (event: string, fn: () => void) => { listeners.set(event, fn); return event; }, off: vi.fn() } as unknown as NonNullable<typeof window.TTMinis>;
    const h = recoveryHarness(configure);
    return { ...h, hide: () => act(() => listeners.get("minis.hide")!()), show: () => act(() => listeners.get("minis.show")!()),
      dispose: () => { h.view.unmount(); window.TTMinis = previousSDK; } };
  };
  it("独立播放器在首帧前只准备下一集授权，切集复用授权和播放器", async () => {
    const h = recoveryHarness(runtime => {
      runtime.preloadMedia = vi.fn(async () => {});
      runtime.resolvePlaybackBatch = vi.fn(async (_dramaId, ids) => ids.map(directResult));
    });
    await waitFor(() => expect(h.runtime.resolvePlaybackBatch).toHaveBeenCalledExactlyOnceWith("drama-1", ["episode-2"]));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    expect(h.engine.switchSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vid: "vid-2" }));
    expect(h.engine.mount).toHaveBeenCalledOnce();
    expect(h.api.resolvePlay).not.toHaveBeenCalledWith("drama-1", "episode-2");
    expect(h.runtime.preloadMedia).not.toHaveBeenCalled();
  });
  it.each([false, true])("首集取流后只提交尚属当前页面的下一集授权，已切走=%s", async switched => {
    const defer = vi.fn<NonNullable<PlaybackEngine["whenInitialMediaLoading"]>>();
    const h = recoveryHarness(runtime => {
      runtime.createPlaybackEngine().whenInitialMediaLoading = defer;
      runtime.prefetchPlaybackInfo = vi.fn();
      runtime.resolvePlaybackBatch = vi.fn(async (_dramaId, ids) => ids.map(directResult));
    });
    await waitFor(() => expect(defer).toHaveBeenCalledExactlyOnceWith("vid-1", expect.any(Function)));
    expect(h.runtime.prefetchPlaybackInfo).not.toHaveBeenCalled();
    if (switched) fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    act(() => defer.mock.calls[0][1]());
    if (switched) expect(h.runtime.prefetchPlaybackInfo).not.toHaveBeenCalled();
    else expect(h.runtime.prefetchPlaybackInfo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vid: "vid-2" }));
  });
  it.each([true, false])("首帧后仅预取紧邻一集的可播媒体信息，可播=%s", async playable => {
    const h = recoveryHarness(runtime => {
      runtime.prefetchPlaybackInfo = vi.fn();
      runtime.preloadMedia = vi.fn(async () => {});
      runtime.resolvePlaybackBatch = vi.fn(async (_dramaId: string, ids: string[]) => ids.map(id =>
        !playable && id === "episode-2" ? { status: "unavailable" as const } : directResult(id)));
    });
    await waitFor(() => expect(h.runtime.resolvePlaybackBatch).toHaveBeenCalledExactlyOnceWith("drama-1", ["episode-2"]));
    expect(h.runtime.prefetchPlaybackInfo).not.toHaveBeenCalled();
    await act(async () => h.events().onFirstFrame?.("vid-1"));
    if (playable) {
      expect(h.runtime.prefetchPlaybackInfo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vid: "vid-2" }));
      fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
      expect(h.engine.switchSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vid: "vid-2" }));
    } else expect(h.runtime.prefetchPlaybackInfo).not.toHaveBeenCalled();
    expect(h.runtime.preloadMedia).not.toHaveBeenCalled();
    expect(h.engine.mount).toHaveBeenCalledOnce();
  });
  it("长集播放中更新下一集授权后重新预取新 Token 的媒体信息", async () => {
    let now = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = recoveryHarness(runtime => {
      runtime.prefetchPlaybackInfo = vi.fn();
      runtime.resolvePlaybackBatch = vi.fn(async (_dramaId, ids) => ids.map(directResult));
    });
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      await act(async () => h.events().onFirstFrame?.("vid-1"));
      expect(h.runtime.prefetchPlaybackInfo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ vid: "vid-2" }));
      vi.mocked(h.runtime.resolvePlaybackBatch!).mockImplementationOnce(async (_dramaId, ids) => ids.map(id => {
        const result = directResult(id);
        if (result.status === "playable") result.playback.playAuthToken = "refreshed-test-token";
        return result;
      }));
      now += 20_001;
      await act(async () => h.events().onTimeUpdate?.({ currentTime: 21, duration: 60, paused: false, ended: false }));
      expect(h.runtime.prefetchPlaybackInfo).toHaveBeenCalledTimes(2);
      expect(h.runtime.prefetchPlaybackInfo).toHaveBeenLastCalledWith(expect.objectContaining({
        vid: "vid-2", playAuthToken: "refreshed-test-token",
      }));
    } finally { clock.mockRestore(); }
  });
  it("切到第二集后 SDK 错误刷新当前集并重建当前媒体", async () => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
    await act(async () => {});
    vi.mocked(h.api.resolvePlay).mockClear();
    await act(async () => h.events().onError?.(new Error("test SDK authorization failed")));
    // 恢复完成后允许刷新相邻集；第一笔验权必须针对当前集。
    expect(vi.mocked(h.api.resolvePlay).mock.calls[0]).toEqual(["drama-1", "episode-2"]);
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ vid: "vid-2" }), expect.anything());
    expect(h.engine.destroy).toHaveBeenCalledOnce();
    expect(h.runtime.invalidatePlayback).toHaveBeenCalledOnce();
  });
  it("同集故障保存最新内核位置，重建就绪后只定位一次", async () => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    await act(async () => h.events().onError?.(new Error("test SDK authorization failed")));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    expect(h.localLibrary.recordProgress).toHaveBeenCalledWith(expect.objectContaining({ episodeId: "episode-1", progressSeconds: 10 }));
    expect(h.engine.seek).not.toHaveBeenCalled();
    act(() => { h.events().onReady?.(); h.events().onReady?.(); });
    expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
  });
  it.each([false, true])("自动恢复耗尽后的手动重试释放故障内核，安装新 Token 并恢复最新位置，原来暂停=%s", async wasPaused => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    act(() => h.events().onError?.(new Error("test first failure")));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    act(() => h.events().onReady?.());
    vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: 25, duration: 60, paused: wasPaused, ended: false });
    act(() => h.events().onError?.(new Error("test exhausted recovery")));
    const next = directResult();
    if (next.status !== "playable") throw new Error("测试夹具必须可播");
    next.playback.playAuthToken = "test-manual-retry-token";
    vi.mocked(h.api.resolvePlay).mockResolvedValueOnce(next);
    fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
    expect(h.engine.destroy).toHaveBeenCalledTimes(2);
    expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ playAuthToken: "test-manual-retry-token" }), expect.anything());
    expect(directPlayerOptions(vi.mocked(h.engine.mount).mock.calls[2][1]).autoplay).toBe(!wasPaused);
    act(() => { h.events().onReady?.(); h.events().onReady?.(); });
    expect(h.engine.seek).toHaveBeenCalledTimes(2);
    expect(h.engine.seek).toHaveBeenLastCalledWith(25);
    expect(h.engine.switchSource).not.toHaveBeenCalled();
    expect(h.engine.play).not.toHaveBeenCalled();
  });
  it.each([0, 10])("手动暂停在 %s 秒时发生故障，重建保留暂停且只恢复有效位置", async position => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    act(() => { h.events().onPlay?.(); h.events().onPause?.(); });
    vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: position, duration: 60, paused: true, ended: false });
    act(() => h.events().onError?.(new Error("test paused failure")));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    const source = vi.mocked(h.engine.mount).mock.calls[1][1];
    expect(directPlayerOptions(source).autoplay).toBe(false);
    act(() => { h.events().onReady?.(); h.events().onReady?.(); });
    if (position) expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(position);
    else expect(h.engine.seek).not.toHaveBeenCalled();
    expect(h.engine.play).not.toHaveBeenCalled();
  });
  it("切走再回到同集，未开始播放的默认暂停不能继承上次访问的播放状态", async () => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    act(() => h.events().onPlay?.());
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-2" })));
    fireEvent.click(screen.getByRole("button", { name: text("player.previousEpisode") }));
    await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-1" })));
    vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: 0, duration: 60, paused: true, ended: false });
    act(() => h.events().onError?.(new Error("test failure before playback started")));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    expect(directPlayerOptions(vi.mocked(h.engine.mount).mock.calls[1][1]).autoplay).toBe(true);
    act(() => h.events().onReady?.());
    expect(h.engine.seek).not.toHaveBeenCalled();
  });
  it.each([false, true])("恢复授权在后台完成后，回前台重新验权再挂载，原来暂停=%s", async wasPaused => {
    const listeners = new Map<string, () => void>();
    const previousSDK = window.TTMinis;
    window.TTMinis = { on: (event: string, fn: () => void) => { listeners.set(event, fn); return event; }, off: vi.fn() } as unknown as NonNullable<typeof window.TTMinis>;
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    const h = recoveryHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: 10, duration: 60, paused: wasPaused, ended: false });
      let finishHidden!: (value: PlayResolveResult) => void;
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finishHidden = resolve; }));
      act(() => h.events().onError?.(new Error("test interrupted recovery")));
      act(() => listeners.get("minis.hide")!());
      const hidden = directResult();
      await act(async () => finishHidden(hidden));
      expect(h.engine.mount).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 120_000);
      let finishForeground!: (value: PlayResolveResult) => void;
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finishForeground = resolve; }));
      const before = vi.mocked(h.api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1").length;
      act(() => listeners.get("minis.show")!());
      expect(vi.mocked(h.api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1")).toHaveLength(before + 1);
      await act(async () => {});
      expect(h.engine.mount).toHaveBeenCalledOnce();
      const fresh = directResult();
      if (fresh.status !== "playable") throw new Error("测试夹具必须可播");
      fresh.playback.playAuthToken = "test-fresh-foreground-token";
      await act(async () => finishForeground(fresh));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      const source = vi.mocked(h.engine.mount).mock.calls[1][1];
      expect(source.playAuthToken).toBe("test-fresh-foreground-token");
      expect(() => validateDirectSource(source)).not.toThrow();
      expect(directPlayerOptions(source).autoplay).toBe(!wasPaused);
      act(() => { h.events().onReady?.(); h.events().onReady?.(); });
      expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
      expect(h.engine.play).not.toHaveBeenCalled();
      const after = vi.mocked(h.api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1").length;
      act(() => h.events().onError?.(new Error("test recovery budget remains exhausted")));
      expect(screen.getByRole("button", { name: text("common.retry") })).toBeInTheDocument();
      expect(vi.mocked(h.api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1")).toHaveLength(after);
    } finally { h.view.unmount(); window.TTMinis = previousSDK; clock.mockRestore(); }
  });
  it("重建未 READY 就进入后台，新内核的零进度和默认暂停不能覆盖恢复意图", async () => {
    const h = visibilityHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => { h.events().onPlay?.(); h.events().onError?.(new Error("test SDK refresh")); });
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: 0, duration: 60, paused: true, ended: false });
      h.hide();
      h.show();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      expect(directPlayerOptions(vi.mocked(h.engine.mount).mock.calls[2][1]).autoplay).toBe(true);
      act(() => { h.events().onReady?.(); h.events().onReady?.(); });
      expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
    } finally { h.dispose(); }
  });
  it("连续进出后台的旧授权迟到不能覆盖最近一次前台许可", async () => {
    const h = visibilityHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      let finishOriginal!: (value: PlayResolveResult) => void;
      let finishFirstShow!: (value: PlayResolveResult) => void;
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finishOriginal = resolve; }));
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      h.hide();
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finishFirstShow = resolve; }));
      h.show();
      h.hide();
      const fresh = directResult();
      if (fresh.status !== "playable") throw new Error("测试夹具必须可播");
      fresh.playback.playAuthToken = "test-latest-foreground-token";
      vi.mocked(h.api.resolvePlay).mockResolvedValueOnce(fresh);
      h.show();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      await act(async () => { finishOriginal(directResult()); finishFirstShow({ status: "unavailable" }); });
      expect(h.engine.mount).toHaveBeenCalledTimes(2);
      expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ playAuthToken: "test-latest-foreground-token" }), expect.anything());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
    } finally { h.dispose(); }
  });
  it.each(["切集", "离页"])("前台恢复验权未完成时%s，迟到结果不能挂载或定位旧集", async action => {
    const h = visibilityHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      h.hide();
      let finish!: (value: PlayResolveResult) => void;
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      h.show();
      if (action === "切集") {
        fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
        await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      } else h.view.unmount();
      const mounts = vi.mocked(h.engine.mount).mock.calls.length;
      await act(async () => finish(directResult()));
      expect(h.engine.mount).toHaveBeenCalledTimes(mounts);
      if (action === "切集") {
        expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ vid: "vid-2" }), expect.anything());
        act(() => h.events().onReady?.());
      }
      expect(h.engine.seek).not.toHaveBeenCalled();
      expect(h.engine.play).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });
  it("前台恢复验权失败记录脱敏诊断，手动重试保留进度与暂停意图", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = visibilityHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: 10, duration: 60, paused: true, ended: false });
      act(() => h.events().onError?.(new Error("test paused failure")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      h.hide();
      expect(log).not.toHaveBeenCalled();
      vi.mocked(h.api.resolvePlay).mockRejectedValueOnce(new Error("foreground authorization failed playAuthToken=private-token https://media.example/private"));
      h.show();
      const retry = await screen.findByRole("button", { name: text("common.retry") });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "direct_playback_authorization_refresh_failed", error: "foreground authorization failed playAuthToken=[REDACTED] [URL]" }));
      expect(screen.getByRole("alert")).not.toHaveTextContent("foreground authorization failed");
      expect(h.engine.mount).toHaveBeenCalledTimes(2);
      fireEvent.click(retry);
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      expect(directPlayerOptions(vi.mocked(h.engine.mount).mock.calls[2][1]).autoplay).toBe(false);
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
      expect(h.engine.play).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
    } finally { h.dispose(); log.mockRestore(); }
  });
  it("前台恢复验权返回不可播时不安装旧许可，也不恢复故障前的位置", async () => {
    const h = visibilityHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      h.hide();
      vi.mocked(h.api.resolvePlay).mockResolvedValueOnce({ status: "unavailable" });
      h.show();
      await screen.findByRole("button", { name: text("common.retry") });
      expect(h.engine.mount).toHaveBeenCalledTimes(2);
      expect(h.engine.seek).not.toHaveBeenCalled();
      expect(h.engine.play).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });
  it.each([false, true])("恢复中的旧集授权响应不能覆盖后续路由或位置，再次返回同集=%s", async revisit => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    let finish!: (value: PlayResolveResult) => void;
    let pending = true;
    vi.mocked(h.api.resolvePlay).mockImplementation((_drama, id) => {
      if (id === "episode-1" && pending) {
        pending = false;
        return new Promise(resolve => { finish = resolve; });
      }
      return Promise.resolve(directResult(id));
    });
    act(() => h.events().onError?.(new Error("test SDK refresh")));
    fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    if (revisit) {
      fireEvent.click(screen.getByRole("button", { name: text("player.previousEpisode") }));
      await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledWith(expect.objectContaining({ vid: "vid-1" })));
    }
    await act(async () => finish(directResult()));
    act(() => h.events().onReady?.());
    expect(h.engine.mount).toHaveBeenCalledTimes(2);
    expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ vid: "vid-2" }), expect.anything());
    expect(h.engine.seek).not.toHaveBeenCalled();
  });
  it.each([false, true])("重新验权返回新 VID 时不把旧视频进度写入新媒体并保留播放意图，原来暂停=%s", async wasPaused => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    const next = directResult();
    if (next.status !== "playable") throw new Error("测试夹具必须可播");
    next.playback.vid = "replacement-vid";
    vi.spyOn(h.engine, "snapshot").mockReturnValue({ currentTime: 10, duration: 60, paused: wasPaused, ended: false });
    vi.mocked(h.api.resolvePlay).mockResolvedValueOnce(next);
    act(() => h.events().onError?.(new Error("test SDK refresh")));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    act(() => h.events().onReady?.());
    expect(h.engine.seek).not.toHaveBeenCalled();
    expect(directPlayerOptions(vi.mocked(h.engine.mount).mock.calls[1][1]).autoplay).toBe(!wasPaused);
  });
  it("授权刷新失败记录脱敏错误，手动重试后仍恢复同集位置", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = recoveryHarness();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      expect(log).not.toHaveBeenCalled();
      vi.mocked(h.api.resolvePlay).mockRejectedValueOnce(new Error("refresh transport failed playAuthToken=private-token https://media.example/private"));
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      const retry = await screen.findByRole("button", { name: text("common.retry") });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "direct_playback_authorization_refresh_failed", error: "refresh transport failed playAuthToken=[REDACTED] [URL]" }));
      expect(screen.getByRole("alert")).not.toHaveTextContent("refresh transport failed");
      fireEvent.click(retry);
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenCalledWith(10);
    } finally { log.mockRestore(); }
  });
  it("定位失败保留诊断与统一重试提示，不泄漏媒体地址或循环验权", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = recoveryHarness();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      vi.mocked(h.engine.seek).mockImplementation(() => { throw new Error("seek failed https://media.example/private playAuthToken=private-token"); });
      const before = vi.mocked(h.api.resolvePlay).mock.calls.length;
      act(() => h.events().onReady?.());
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "direct_playback_position_restore_failed", error: "seek failed [URL] playAuthToken=[REDACTED]" }));
      expect(screen.getByRole("button", { name: text("common.retry") })).toBeInTheDocument();
      expect(h.api.resolvePlay).toHaveBeenCalledTimes(before);
    } finally { log.mockRestore(); }
  });
  it("SDK 挂载期间同步通知定位失败，旧挂载结果不能阻断手动重建", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = recoveryHarness();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      vi.mocked(h.engine.seek).mockImplementationOnce(() => { throw new Error("test synchronous seek failure"); });
      vi.mocked(h.engine.mount).mockImplementationOnce(async (_root, _source, next) => {
        next?.onReady?.();
        return true;
      });
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      const retry = await screen.findByRole("button", { name: text("common.retry") });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "direct_playback_position_restore_failed", error: "test synchronous seek failure" }));
      fireEvent.click(retry);
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenCalledTimes(2);
      expect(h.engine.seek).toHaveBeenLastCalledWith(10);
    } finally { log.mockRestore(); }
  });
  it("SDK 错误只自动重新验权一次，重建内核后再次失败留给手动重试", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, next) => { callbacks = next || {}; return true; }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 10, duration: 60, paused: false, ended: false }),
    };
    const { runtime, api } = createPlayerRuntime(engine);
    vi.mocked(api.resolvePlay).mockImplementation(async (_drama, id) => directResult(id));
    render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
    const before = vi.mocked(api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1").length;
    act(() => callbacks.onError?.(new Error("test SDK authorization failed")));
    await waitFor(() => expect(engine.mount).toHaveBeenCalledTimes(2));
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(vi.mocked(api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1")).toHaveLength(before + 1);
    act(() => callbacks.onError?.(new Error("test SDK still unavailable")));
    await waitFor(() => expect(screen.getByRole("button", { name: text("common.retry") })).toBeInTheDocument());
    expect(vi.mocked(api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1")).toHaveLength(before + 1);
  });
  it("离页后的授权响应不能重新创建播放器或恢复播放", async () => {
    let callbacks: PlaybackCallbacks = {};
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, next) => { callbacks = next || {}; return true; }),
      switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
    };
    const { runtime, api } = createPlayerRuntime(engine);
    vi.mocked(api.resolvePlay).mockImplementation(async (_drama, id) => directResult(id));
    const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}><Routes><Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} /></Routes></MemoryRouter></RuntimeContext.Provider>);
    await waitFor(() => expect(engine.mount).toHaveBeenCalledOnce());
    let finish!: (value: PlayResolveResult) => void;
    vi.mocked(api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => callbacks.onError?.(new Error("test SDK refresh")));
    view.unmount();
    await act(async () => { finish(directResult()); });
    expect(engine.mount).toHaveBeenCalledOnce(); expect(engine.play).not.toHaveBeenCalled();
  });
  it.each(["原 VID", "新 VID", "不可播"])("权益刷新抢占前台恢复后安装权威结果：%s", async outcome => {
    let listener!: (event: EntitlementChange) => void;
    const h = visibilityHarness(runtime => {
      runtime.getApplicationID = () => "app-1";
      runtime.getEntitlementRevision = () => 0;
      runtime.subscribeEntitlements = next => { listener = next; return () => {}; };
    });
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      h.hide();
      let finish!: (value: PlayResolveResult) => void;
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      h.show();
      const fresh = directResult();
      if (fresh.status !== "playable") throw new Error("测试夹具必须可播");
      fresh.playback.playAuthToken = "test-entitlement-token";
      if (outcome === "新 VID") fresh.playback.vid = "replacement-vid";
      vi.mocked(h.api.resolvePlay).mockResolvedValueOnce(outcome === "不可播" ? { status: "unavailable" } : fresh);
      await act(async () => listener({
        revision: 1, applicationId: "app-1", visitorId: "visitor-1", identityGeneration: 1,
        rewardType: "vip_progress", cause: "vip_recheck",
      }));
      await act(async () => finish(directResult()));
      if (outcome === "不可播") {
        expect(screen.getByRole("button", { name: text("common.retry") })).toBeInTheDocument();
        expect(h.engine.mount).toHaveBeenCalledTimes(2);
        expect(h.engine.seek).not.toHaveBeenCalled();
        return;
      }
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        vid: fresh.playback.vid, playAuthToken: "test-entitlement-token",
      }), expect.anything());
      act(() => h.events().onReady?.());
      if (outcome === "原 VID") expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
      else expect(h.engine.seek).not.toHaveBeenCalled();
    } finally { h.dispose(); }
  });
  it.each(["vip_progress", "episode_unlock"] as const)("后台 %s 通知不能代替回前台的新验权", async rewardType => {
    let listener!: (event: EntitlementChange) => void;
    const h = visibilityHarness(runtime => {
      runtime.getApplicationID = () => "app-1";
      runtime.getEntitlementRevision = () => 0;
      runtime.subscribeEntitlements = next => { listener = next; return () => {}; };
    });
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      h.hide();
      await act(async () => listener({
        revision: 1, applicationId: "app-1", visitorId: "visitor-1", identityGeneration: 1,
        rewardType, cause: rewardType === "vip_progress" ? "vip_recheck" : undefined,
        dramaId: "drama-1", episodeId: "episode-1", playback: directResult(),
      }));
      expect(h.engine.mount).toHaveBeenCalledTimes(2);
      const before = vi.mocked(h.api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1").length;
      const fresh = directResult();
      if (fresh.status !== "playable") throw new Error("测试夹具必须可播");
      fresh.playback.playAuthToken = "test-show-token";
      vi.mocked(h.api.resolvePlay).mockResolvedValueOnce(fresh);
      h.show();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      expect(vi.mocked(h.api.resolvePlay).mock.calls.filter(([, id]) => id === "episode-1")).toHaveLength(before + 1);
      expect(h.engine.mount).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        playAuthToken: "test-show-token",
      }), expect.anything());
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
    } finally { h.dispose(); }
  });
  it("异步定位确认前保留恢复位置，时间更新不把零进度写回历史", async () => {
    const h = recoveryHarness();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    act(() => h.events().onError?.(new Error("test SDK refresh")));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
    vi.mocked(h.engine.snapshot).mockReturnValue({ currentTime: 0, duration: 60, paused: true, ended: false });
    act(() => {
      h.events().onReady?.();
      h.events().onReady?.();
      h.events().onTimeUpdate?.(h.engine.snapshot());
    });
    expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
    expect(h.localLibrary.recordProgress).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ progressSeconds: 10 }));
    vi.mocked(h.engine.snapshot).mockReturnValue({ currentTime: 10, duration: 60, paused: true, ended: false });
    act(() => h.events().onSeeked?.());
    vi.mocked(h.engine.snapshot).mockReturnValue({ currentTime: 25, duration: 60, paused: true, ended: false });
    act(() => h.events().onError?.(new Error("test exhausted recovery")));
    fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
    act(() => h.events().onReady?.());
    expect(h.engine.seek).toHaveBeenCalledTimes(2);
    expect(h.engine.seek).toHaveBeenLastCalledWith(25);
  });
  it("定位尚未确认时再次进入后台，回前台仍恢复原位置", async () => {
    const h = visibilityHarness();
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test SDK refresh")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      vi.mocked(h.engine.snapshot).mockReturnValue({ currentTime: 0, duration: 60, paused: true, ended: false });
      const oldCallbacks = h.events();
      act(() => oldCallbacks.onReady?.());
      expect(h.engine.seek).toHaveBeenCalledExactlyOnceWith(10);
      h.hide();
      act(() => oldCallbacks.onSeeked?.());
      h.show();
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenCalledTimes(2);
      expect(h.engine.seek).toHaveBeenLastCalledWith(10);
    } finally { h.dispose(); }
  });
  it("前台验权失败不能让旧手动请求占住新的重试", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = visibilityHarness();
    let finish!: (value: PlayResolveResult) => void;
    try {
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
      act(() => h.events().onError?.(new Error("test first failure")));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(2));
      act(() => { h.events().onReady?.(); h.events().onError?.(new Error("test second failure")); });
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
      h.hide();
      vi.mocked(h.api.resolvePlay).mockRejectedValueOnce(new Error("test foreground failure"));
      h.show();
      await waitFor(() => expect(log).toHaveBeenCalled());
      const retry = screen.getByRole("button", { name: text("common.retry") });
      const before = vi.mocked(h.api.resolvePlay).mock.calls.length;
      let finishNew!: (value: PlayResolveResult) => void;
      vi.mocked(h.api.resolvePlay).mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
      fireEvent.click(retry);
      expect(h.api.resolvePlay).toHaveBeenCalledTimes(before + 1);
      await act(async () => finish(directResult()));
      // 旧请求的 finally 不能释放新请求的占用；连续点击仍只能发起一次当前重试。
      fireEvent.click(retry);
      expect(h.api.resolvePlay).toHaveBeenCalledTimes(before + 1);
      await act(async () => finishNew(directResult()));
      await waitFor(() => expect(h.engine.mount).toHaveBeenCalledTimes(3));
      act(() => h.events().onReady?.());
      expect(h.engine.seek).toHaveBeenLastCalledWith(10);
    } finally {
      if (finish) await act(async () => finish(directResult()));
      h.dispose();
      log.mockRestore();
    }
  });
  it.each(["complete", "durationchange", "canplay"])("READY 早于媒体元数据时在 %s 后恢复暂停位置", async mediaEvent => {
    const instances: FakeSDK[] = [];
    const vendor = readFileSync("node_modules/@byteplus/veplayer/index.min.js", "utf8");
    const seekSource = vendor.match(/key:"seek",value:(function\(A,e\)\{[\s\S]*?)\}\},\{key:"getInitDefinition"/);
    if (!seekSource) throw new Error("未找到随包 SDK 的 seek 实现");
    // 执行依赖中实际 seek 函数；只注入其枚举与纯数值检查，保留 duration 裁剪和就绪分支。
    const sdkSeek = new Function("IN", "gF", "eF", "_L", "return " + seekSource[1] + "}")(
      Number.isNaN, {RUNNING:3}, {ENTER:"enter",NO_START:"no_start"}, "canplay",
    );
    class FakeSDK {
      static Events = { READY: "ready", COMPLETE: "complete", ERROR: "error" };
      listeners = new Map<string, (value?: unknown) => void>();
      player = {
        currentTime: 0, duration: 0, readyState: 0, paused: true, ended: false, hasStart: true, media: {}, config: {},
        state: 3, once: vi.fn(), off: vi.fn(), removeClass: vi.fn(),
        // SDK 随包 XG 内核 seek 会把目标位置裁剪到当前 duration；READY 尚未加载元数据时为零。
        seek: vi.fn((seconds: number) => { sdkSeek.call(this.player, seconds); }),
        play: vi.fn(async () => { this.player.paused = false; }),
        pause: vi.fn(() => { this.player.paused = true; }),
      };
      constructor() { instances.push(this); }
      on(event: string, next: (value?: unknown) => void) { this.listeners.set(event, next); }
      off(event: string) { this.listeners.delete(event); }
      emit(event: string, value?: unknown) { this.listeners.get(event)?.(value); }
      destroy() { this.listeners.clear(); }
      async playNext() {}
    }
    const h = recoveryHarness(runtime => {
      runtime.createPlaybackEngine = () => new SDKPlaybackEngine(
        { getConstructor: async () => FakeSDK } as never, directPlayerOptions, validateDirectSource,
      );
    });
    try {
      await waitFor(() => expect(instances).toHaveLength(1));
      instances[0].player.currentTime = 10;
      instances[0].player.duration = 60;
      act(() => instances[0].emit("error", new Error("test SDK fault")));
      await waitFor(() => expect(instances).toHaveLength(2));
      act(() => { instances[1].emit("ready"); instances[1].emit("complete"); });
      expect(instances[1].player.seek).not.toHaveBeenCalled();
      instances[1].player.duration = 60;
      act(() => instances[1].emit("complete"));
      expect(instances[1].player.seek).not.toHaveBeenCalled();
      instances[1].player.readyState = 1;
      act(() => { instances[1].emit(mediaEvent); instances[1].emit(mediaEvent); });
      expect(instances[1].player.currentTime).toBe(10);
      expect(instances[1].player.seek).toHaveBeenCalledExactlyOnceWith(10);
      expect(instances[1].player.paused).toBe(true);
      expect(instances[1].player.play).not.toHaveBeenCalled();
    } finally { h.view.unmount(); }
  });

});

// 目录更新后使用真实 runtime 缓存验证切集重新验权，响应不需要内容版本字段。
it.each([[1, 2], [2, 1]])("线上媒资从 %s 切换到 %s 后切集重新取得播放许可", async (from, to) => {
  const h = playbackRegressionHarness();
  const { PlaybackCache } = await import("../runtime/playbackCache");
  const cache = new PlaybackCache();
  const beforeDetail = { ...drama };
  const afterDetail = { ...drama, title: "当前上架内容" };
  let mediaNumber = from;
  let entitlementListener!: (event: EntitlementChange) => void;
  h.runtime.getApplicationID = () => "application";
  h.runtime.subscribeEntitlements = listener => { entitlementListener = listener; return () => undefined; };
  h.api.drama = vi.fn(async () => mediaNumber === from ? beforeDetail : afterDetail);
  h.api.resolvePlay = vi.fn(async (_id, id): Promise<PlayResolveResult> => {
    const episode = drama.episodes.find(item => item.id === id)!;
    return { status: "playable", drama: mediaNumber === from ? beforeDetail : afterDetail, episode, playback: { ...playbackFor(episode), vid: `v${mediaNumber}-${episode.id}` } };
  });
  h.runtime.resolvePlayback = vi.fn((id, episode) => cache.resolve("application:visitor-1", id, episode, () => h.api.resolvePlay(id, episode)));
  h.runtime.invalidatePlayback = vi.fn(() => cache.clear(false));
  h.mount();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  await waitFor(() => expect(h.runtime.resolvePlayback).toHaveBeenCalledWith(drama.id, "episode-2"));
  const oldCalls = vi.mocked(h.runtime.resolvePlayback).mock.calls.filter(call => call[1] === "episode-2").length;
  mediaNumber = to;
  act(() => entitlementListener({ applicationId: "application", visitorId: "visitor-1", identityGeneration: 0, revision: 1, rewardType: "episode_unlock", dramaId: drama.id, episodeId: "episode-3" }));
  await waitFor(() => expect(h.api.drama).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledTimes(2));
  const source = vi.mocked(h.engine.switchSource).mock.calls.at(-1)![0];
  expect(vi.mocked(h.runtime.resolvePlayback).mock.calls.filter(call => call[1] === "episode-2").length).toBeGreaterThan(oldCalls);
  expect(source.vid).toBe(`v${to}-episode-2`);
});

// 目录刷新前发起的相邻许可迟到时不能回填当前缓存或播放器预热。
it("目录刷新后拒收迟到的相邻集许可并保留观看进度", async () => {
  const h = playbackRegressionHarness();
  const { PlaybackCache } = await import("../runtime/playbackCache");
  const cache = new PlaybackCache();
  let mediaNumber = 1;
  let finishOld!: (result: PlayResolveResult) => void;
  let listener!: (event: EntitlementChange) => void;
  h.runtime.getApplicationID = () => "application";
  h.runtime.subscribeEntitlements = next => { listener = next; return () => undefined; };
  h.api.drama = vi.fn(async () => ({ ...drama }));
  const resolved = (id: string, number: number): PlayResolveResult => {
    const episode = drama.episodes.find(value => value.id === id)!;
    return { status: "playable", drama: { ...drama }, episode, playback: { ...playbackFor(episode), vid: `v${number}-${id}` } };
  };
  h.api.resolvePlay = vi.fn(async (_id, id) => {
    if (id === "episode-2" && mediaNumber === 1) return new Promise<PlayResolveResult>(resolve => { finishOld = resolve; });
    return resolved(id, mediaNumber);
  });
  h.runtime.resolvePlayback = vi.fn((id, episode) => cache.resolve("application:visitor-1", id, episode, () => h.api.resolvePlay(id, episode)));
  h.runtime.invalidatePlayback = vi.fn(() => cache.clear(false));
  h.mount();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  await waitFor(() => expect(finishOld).toBeTypeOf("function"));
  mediaNumber = 2;
  act(() => listener({ applicationId: "application", visitorId: "visitor-1", identityGeneration: 0, revision: 1, rewardType: "episode_unlock", dramaId: drama.id, episodeId: "episode-3" }));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledOnce());
  await act(async () => finishOld(resolved("episode-2", 1)));
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(h.engine.switchSource).toHaveBeenCalledTimes(2));
  expect(vi.mocked(h.engine.switchSource).mock.calls.at(-1)![0].vid).toBe("v2-episode-2");
  expect(h.localLibrary.recordProgress).not.toHaveBeenCalled();

});

// 目录刷新只撤销候选；在播媒体和进度不受影响，预加载故障有可定位且脱敏的日志。
it.each([false, true])("目录刷新保留在播内容，候选更新失败=%s", async failPreload => {
  const h = playbackRegressionHarness();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let listener!: (event: EntitlementChange) => void;
  let finishDirectory!: (value: DramaDetail) => void;
  h.runtime.getApplicationID = () => "application";
  h.runtime.subscribeEntitlements = next => { listener = next; return () => undefined; };
  vi.mocked(h.api.drama).mockResolvedValueOnce(drama).mockImplementation(() => new Promise(resolve => { finishDirectory = resolve; }));
  try {
    h.mount();
    await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
    await waitFor(() => expect(h.api.resolvePlay).toHaveBeenCalledWith(drama.id, "episode-2"));
    const current = { status: "playable" as const, drama, episode: drama.episodes[0], playback: playbackFor(drama.episodes[0]) };
    act(() => listener({ applicationId: "application", visitorId: "visitor-1", identityGeneration: 0, revision: 1,
      rewardType: "episode_unlock", dramaId: drama.id, episodeId: drama.firstEpisodeId, playback: current }));
    await waitFor(() => expect(finishDirectory).toBeTypeOf("function"));
    if (failPreload) vi.mocked(h.runtime.preloadMedia!).mockRejectedValue(new Error("test directory preload failure token=private-token https://media.example/private"));
    await act(async () => finishDirectory({ ...drama, title: "当前上架目录" }));
    expect(h.engine.destroy).not.toHaveBeenCalled();
    expect(h.engine.switchSource).not.toHaveBeenCalled();
    expect(h.engine.seek).not.toHaveBeenCalled();
    expect(h.runtime.clearMediaPreload).not.toHaveBeenCalled();
    expect(h.localLibrary.recordProgress).not.toHaveBeenCalled();
    expect(h.runtime.preloadMedia).toHaveBeenCalledWith([expect.objectContaining({ vid: "vid-1" })], 1);
    if (failPreload) {
      const refreshFailures = warning.mock.calls.filter(([record]) => record?.event === "directory_preload_refresh_failed");
      expect(refreshFailures).toEqual([[{ event: "directory_preload_refresh_failed", error: "test directory preload failure token=[REDACTED] [URL]" }]]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-token");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("https://media.example");
    } else expect(warning).not.toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});


it("同集权益刷新不重复回传播放请求，切集形成新请求", async () => {
  const h = playbackRegressionHarness();
  let changed!: (change: EntitlementChange) => void;
  h.runtime.getApplicationID = () => "101";
  h.runtime.subscribeEntitlements = listener => { changed = listener; return () => {}; };
  h.mount();
  await waitFor(() => expect(h.engine.mount).toHaveBeenCalledOnce());
  const requests = () => vi.mocked(h.runtime.reportPlaybackEvent!).mock.calls.filter(([event]) => event === "video_play_request");
  expect(requests()).toHaveLength(1);
  const before = vi.mocked(h.api.resolvePlay).mock.calls.length;
  act(() => changed({ applicationId: "101", visitorId: "visitor-1", identityGeneration: 1, revision: 1, rewardType: "episode_unlock", dramaId: "drama-1", episodeId: "episode-2" }));
  await waitFor(() => expect(vi.mocked(h.api.resolvePlay).mock.calls.length).toBeGreaterThan(before));
  expect(requests()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: text("player.nextEpisode") }));
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(requests()[1][2]).toBe("episode-2");
});
