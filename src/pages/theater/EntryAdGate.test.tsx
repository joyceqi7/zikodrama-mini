import { ServerClock } from "../../domain/serverTime";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import type { AdExperience, EntryAdStatus } from "../../domain/types";
import { RuntimeContext } from "../../runtime/RuntimeContext";
import type { Runtime } from "../../runtime/runtime";
import { text } from "../../copy";
import { EntryAdGate } from "./EntryAdGate";
import { showRewardedAd } from "../../platform/tiktok/rewardedAd";
import { hasPendingFullscreenAd } from "../../platform/tiktok/fullscreenAd";
import type { RewardedAdCloseResult, TikTokMinisSDK } from "../../platform/tiktok/types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function entryStatus(completedCount: number, requiredCount = 2): EntryAdStatus {
  return new ServerClock().bind({
    enabled: true,
    scope: "user", countBy: "completed",
    completedCount,
    requiredCount,
    progressDate: "2026-10-08",
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    offer: { offerId: "entry-offer", adUnitId: "ad-unit", kind: "rewarded_entry" },
  } satisfies EntryAdStatus, new Date().toISOString(), performance.now(), 0, 0);
}

/** renderGate 为广告测试提供目标剧集路由和按身份隔离的空历史。 */
function renderGate(runtime: Runtime, route = "/watch/drama-1/episode-1") {
  runtime.localLibrary ??= { history: () => [] } as unknown as Runtime["localLibrary"];
  return render(<RuntimeContext.Provider value={runtime}>
    <MemoryRouter initialEntries={[route]}>
      <Routes><Route path="/watch/:dramaId/:episodeId" element={<EntryAdGate><div data-testid="player">Player</div></EntryAdGate>} /></Routes>
    </MemoryRouter>
  </RuntimeContext.Provider>);
}

/** delayedEntryRuntime 提供未达标广告状态与显式延迟，不创建播放器。 */
function delayedEntryRuntime(delaySeconds: number, entryAdStatus: Runtime["api"]["entryAdStatus"]): Runtime {
  const experience: AdExperience = {
    vipState: { active: false, adCount: 0, requiredCount: 0, progressDate: "" },
    monetizationPolicy: {
      status: "enabled", strategy: "rules", freeEpisodeCount: 1, entryAdDelaySeconds: delaySeconds,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: false, requiredAdCount: 0, title: "", content: "" },
    },
  };
  return {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", getAdExperience: () => experience,
    subscribeAdExperience: () => () => {}, hasPendingAdClaim: () => false,
    showEntryAd: vi.fn(() => new Promise(() => {})),
  } as unknown as Runtime;
}

it.each([0, 4])("延迟 %s 秒时，资格晚于前台截止时间返回，确认后直接拉起且不依赖播放器", async delay => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  let confirm!: (status: EntryAdStatus) => void;
  const runtime = delayedEntryRuntime(delay, () => new Promise(resolve => { confirm = resolve; }));
  renderGate(runtime);
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => confirm(entryStatus(0)));
  expect(runtime.showEntryAd).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("player")).toBeNull();
});

it("详情在后台暂停计时，回前台按剩余时间继续并使用新广告资格", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const entryAdStatus = vi.fn(async () => entryStatus(0));
  const runtime = delayedEntryRuntime(4, entryAdStatus);
  renderGate(runtime);
  await act(async () => vi.advanceTimersByTimeAsync(1_500));
  fireEvent(window, new Event("pagehide"));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
  fireEvent(window, new Event("pageshow"));
  await act(async () => vi.advanceTimersByTimeAsync(2_499));
  expect(entryAdStatus).toHaveBeenCalledTimes(2);
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(runtime.showEntryAd).toHaveBeenCalledOnce();
});

it("离开详情取消待拉起广告，新剧详情重新计时", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const runtime = delayedEntryRuntime(4, async () => entryStatus(0));
  const view = renderGate(runtime);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  view.unmount();
  renderGate(runtime, "/watch/drama-2/episode-1");
  await act(async () => vi.advanceTimersByTimeAsync(3_999));
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(runtime.showEntryAd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dramaId: "drama-2" }), false, expect.anything());
});

it.each([
  { countBy: "completed", settledCount: 2 }, { countBy: "shown", settledCount: 2 },
  { countBy: "completed", settledCount: 4 }, { countBy: "shown", settledCount: 4 },
] as const)("$countBy 结算返回 $settledCount 次时直接放行，不补查、不加一、不继续拉广告", async ({ countBy, settledCount }) => {
  let finish: ((value: { status: "completed" }) => void) | undefined;
  const status = { ...entryStatus(0), countBy, shownCount: 0 };
  const settled = { ...entryStatus(settledCount), countBy, shownCount: settledCount };
  const api = { entryAdStatus: vi.fn(async () => status) };
  const runtime = {
    api, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd: vi.fn(() => new Promise(resolve => { finish = resolve; })),
    claimReward: vi.fn(async () => ({ rewardType: "entry_progress", dramaId: "drama-1", entryAdStatus: settled })),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(runtime.showEntryAd).toHaveBeenCalledOnce());
  // 原生广告回前台正在等待结算时，不能先多查一次进度。
  fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
  await act(async () => finish?.({ status: "completed" }));
  await screen.findByTestId("player");
  expect(api.entryAdStatus).toHaveBeenCalledOnce();
  expect(runtime.showEntryAd).toHaveBeenCalledOnce();
});

it("跨日结算按回包的新日期和次数继续，不累计昨日次数，也不补查", async () => {
  const initial = { ...entryStatus(1), progressDate: "2026-10-23" };
  const nextDay = { ...entryStatus(1), progressDate: "2026-10-24" };
  const api = { entryAdStatus: vi.fn(async () => initial) };
  const runtime = {
    api, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd: vi.fn().mockResolvedValueOnce({ status: "completed" }).mockImplementation(() => new Promise(() => {})),
    claimReward: vi.fn(async () => ({ rewardType: "entry_progress", dramaId: "drama-1", entryAdStatus: nextDay })),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(runtime.showEntryAd).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId("player")).toBeNull();
  expect(api.entryAdStatus).toHaveBeenCalledOnce();
  expect(runtime.claimReward).toHaveBeenCalledOnce();
});

it("待确认奖励恢复直接使用结算回包放行，旧服务端无字段才补查", async () => {
  let pending = true;
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(0, 1)) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => pending,
    retryPendingAdClaims: vi.fn(async () => { pending = false; return [{ rewardType: "entry_progress", dramaId: "drama-1", entryAdStatus: entryStatus(1, 1) }]; }),
    showEntryAd: vi.fn(),
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByTestId("player");
  expect(runtime.api.entryAdStatus).toHaveBeenCalledOnce();
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
});

it("广告未退出时切剧，旧剧展示不能放行新剧，退出后再为新剧拉起", async () => {
  const counts = new Map<string, number>();
  const close: Array<() => void> = [];
  const showEntryAd = vi.fn((claim: { dramaId: string }) => {
    counts.set(claim.dramaId, (counts.get(claim.dramaId) ?? 0) + 1);
    return new Promise<{ status: "cancelled" }>(resolve => close.push(() => resolve({ status: "cancelled" })));
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async (dramaId: string) => ({ ...entryStatus(0, 1), scope: "user_drama", countBy: "shown",
      shownCount: counts.get(dramaId) ?? 0, offer: { offerId: "entry", adUnitId: "entry-ad", kind: "rewarded_entry" } })) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd, retryPendingAdShows: vi.fn(async () => {}), localLibrary: { history: () => [] },
  } as unknown as Runtime;
  function SwitchDrama() {
    const navigate = useNavigate();
    return <button onClick={() => navigate("/watch/drama-2/episode-2")}>切换剧目</button>;
  }
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
    <SwitchDrama /><Routes><Route path="/watch/:dramaId/:episodeId" element={<EntryAdGate><div data-testid="player" /></EntryAdGate>} /></Routes>
  </MemoryRouter></RuntimeContext.Provider>);
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "切换剧目" }));
  await waitFor(() => expect(runtime.api.entryAdStatus).toHaveBeenCalledWith("drama-2"));
  expect(screen.queryByTestId("player")).toBeNull();
  expect(showEntryAd).toHaveBeenCalledTimes(1);
  await act(async () => { close[0](); });
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
  expect(showEntryAd.mock.calls[1][0].dramaId).toBe("drama-2");
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => { close[1](); });
  await waitFor(() => expect(screen.getByTestId("player")).toBeInTheDocument());
});

it.each(["shown", "completed"] as const)("%s 模式第一部剧达标后连续切换未达标剧目，均重新拉起入剧广告", async (countBy) => {
  const counts = new Map<string, number>([["drama-1", 3]]);
  const showEntryAd = vi.fn((claim: { dramaId: string }) => {
    counts.set(claim.dramaId, (counts.get(claim.dramaId) ?? 0) + 1);
    return Promise.resolve({ status: "completed" });
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async (dramaId: string) => ({ ...entryStatus(countBy === "completed" ? counts.get(dramaId) ?? 0 : 0, 3),
      scope: "user_drama", countBy, shownCount: countBy === "shown" ? counts.get(dramaId) ?? 0 : 0 })) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
    claimReward: vi.fn(async () => ({ status: "granted", rewardType: "entry_progress" })),
  } as unknown as Runtime;
  function SwitchDrama() {
    const navigate = useNavigate();
    return <>{["drama-2", "drama-3", "drama-4"].map(id => <button key={id} onClick={() => navigate(`/watch/${id}/episode-1`)}>{id}</button>)}</>;
  }
  render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
    <SwitchDrama /><Routes><Route path="/watch/:dramaId/:episodeId" element={<EntryAdGate><div data-testid="player" /></EntryAdGate>} /></Routes>
  </MemoryRouter></RuntimeContext.Provider>);
  await screen.findByTestId("player");
  expect(showEntryAd).not.toHaveBeenCalled();
  for (const [index, id] of ["drama-2", "drama-3", "drama-4"].entries()) {
    fireEvent.click(screen.getByRole("button", { name: id }));
    await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes((index + 1) * 3));
    await screen.findByTestId("player");
    expect(showEntryAd.mock.calls.filter(([claim]) => claim.dramaId === id)).toHaveLength(3);
  }
});

it("展示与领奖跨午夜，旧日展示不误报进度故障，新日未达标自动拉起", async () => {
  let nextDay = false;
  let shown = 0;
  const close: Array<(result: { status: "completed" | "cancelled" }) => void> = [];
  const showEntryAd = vi.fn(() => {
    shown++;
    return new Promise<{ status: "completed" | "cancelled" }>(resolve => close.push(resolve));
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => ({ ...entryStatus(0, 1), progressDate: nextDay ? "2026-10-09" : "2026-10-08",
      scope: "user", countBy: "shown", shownCount: shown, offer: { offerId: "entry", adUnitId: "entry-ad", kind: "rewarded_entry" } })) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
    retryPendingAdShows: vi.fn(async () => {}),
    claimReward: vi.fn(async () => { nextDay = true; shown = 0; return { rewardType: "entry_progress" }; }),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(1));
  await act(async () => { close[0]({ status: "completed" }); });
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => { close[1]({ status: "cancelled" }); });
  await waitFor(() => expect(screen.getByTestId("player")).toBeInTheDocument());
});

it.each([
  ["user", "shown"], ["user_drama", "shown"], ["user", "completed"], ["user_drama", "completed"],
] as const)("%s/%s 取消后自动接续，达到服务端次数才放行", async (scope, countBy) => {
  const counts = new Map<string, { shown: number; completed: number }>();
  const count = (dramaId: string) => {
    const key = scope === "user" ? "all" : dramaId;
    let value = counts.get(key);
    if (!value) { value = { shown: 0, completed: 0 }; counts.set(key, value); }
    return value;
  };
  const close: Array<(result: { status: "cancelled" | "completed" }) => void> = [];
  const showEntryAd = vi.fn((claim: { dramaId: string }) => {
    count(claim.dramaId).shown++;
    return new Promise<{ status: "cancelled" | "completed" }>(resolve => close.push(resolve));
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async (dramaId: string) => ({ ...entryStatus(count(dramaId).completed), scope, countBy,
      shownCount: count(dramaId).shown, offer: { offerId: "entry", adUnitId: "entry-ad", kind: "rewarded_entry" } })) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd, retryPendingAdShows: vi.fn(async () => {}),
    claimReward: vi.fn(async (claim: { dramaId: string }) => { count(claim.dramaId).completed++; return { rewardType: "entry_progress" }; }),
  } as unknown as Runtime;
  const view = renderGate(runtime);
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(1));
  // 成功展示已经加一，原生广告未退出时仍不能挂载播放器。
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => { close[0]({ status: "cancelled" }); });
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
  expect(runtime.claimReward).not.toHaveBeenCalled();
  expect(screen.queryByTestId("player")).toBeNull();
  if (countBy === "shown") {
    await act(async () => { close[1]({ status: "cancelled" }); });
  } else {
    await act(async () => { close[1]({ status: "completed" }); });
    await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId("player")).toBeNull();
    await act(async () => { close[2]({ status: "completed" }); });
  }
  await screen.findByTestId("player");
  expect(runtime.claimReward).toHaveBeenCalledTimes(countBy === "shown" ? 0 : 2);
  view.unmount();
  const prior = showEntryAd.mock.calls.length;
  renderGate(runtime, "/watch/drama-2/episode-1");
  if (scope === "user") {
    await screen.findByTestId("player");
    expect(showEntryAd).toHaveBeenCalledTimes(prior);
  } else {
    await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(prior + 1));
    expect(screen.queryByTestId("player")).toBeNull();
  }
});

it("旧 VIP 配置不强制入剧；新开关只在入剧广告规则关闭时自动拉起 VIP 广告并等待领取", async () => {
  let experience: AdExperience = {
    vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "2026-10-08" },
    vipOffer: { offerId: "vip-offer", adUnitId: "vip-ad", kind: "rewarded_vip" },
    monetizationPolicy: {
      status: "enabled", strategy: "rules", freeEpisodeCount: 1,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requireBeforePlayback: true, requiredAdCount: 1, title: "", content: "" },
    },
  };
  let listener = () => {};
  const watchVIPAd = vi.fn(async () => ({
    claimId: "vip-claim", status: "granted" as const, rewardType: "vip_progress" as const,
    unlocked: false, dramaId: "", episodeId: "",
    vipState: { ...experience.vipState, adCount: 1 },
  }));
  const claimVIP = vi.fn(async () => {
    experience = { ...experience, vipState: { ...experience.vipState, adCount: 1, active: true } };
    listener();
    return experience.vipState;
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })) },
    getSessionSubjectKey: () => "app:user", getAdExperience: () => experience,
    subscribeAdExperience: (callback: () => void) => { listener = callback; return () => { listener = () => {}; }; },
    watchVIPAd, claimVIP,
  } as unknown as Runtime;
  const view = renderGate(runtime);
  await waitFor(() => expect(watchVIPAd).toHaveBeenCalledOnce());
  expect(screen.queryByTestId("player")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Claim today's VIP" }));
  await waitFor(() => expect(screen.getByTestId("player")).toBeTruthy());
  expect(claimVIP).toHaveBeenCalledOnce();

  view.unmount();
  experience = { ...experience, vipState: { ...experience.vipState, active: false }, monetizationPolicy: {
    ...experience.monetizationPolicy, vip: { ...experience.monetizationPolicy.vip, requireBeforePlayback: undefined },
  } };
  renderGate(runtime);
  await screen.findByTestId("player");
  expect(watchVIPAd).toHaveBeenCalledOnce();
});

it("两种入剧策略同时开启时先完成入剧广告，再倒计时拉起 VIP 广告", async () => {
  let completed = 0;
  let finishEntry: ((result: { status: "completed" }) => void) | undefined;
  const order: string[] = [];
  const showEntryAd = vi.fn(() => {
    order.push("entry");
    return new Promise<{ status: "completed" }>(resolve => { finishEntry = resolve; });
  });
  const watchVIPAd = vi.fn(() => { order.push("vip"); return new Promise<null>(() => {}); });
  const experience: AdExperience = {
    vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "2026-10-08" },
    vipOffer: { offerId: "vip-offer", adUnitId: "vip-ad", kind: "rewarded_vip" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requireBeforePlayback: true, entryAdCountdownSeconds: 2, requiredAdCount: 1, title: "", content: "" } },
  };
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(completed, 1)) },
    getSessionSubjectKey: () => "app:user", getAdExperience: () => experience,
    subscribeAdExperience: () => () => {}, hasPendingAdClaim: () => false,
    showEntryAd, watchVIPAd,
    claimReward: vi.fn(async () => { completed = 1; order.push("entry-claim"); return { rewardType: "entry_progress" }; }),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledOnce());
  expect(watchVIPAd).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(watchVIPAd).not.toHaveBeenCalled();
  await act(async () => { finishEntry?.({ status: "completed" }); });
  expect(screen.getByText("Ad starts automatically in 2s")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(watchVIPAd).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(watchVIPAd).toHaveBeenCalledOnce();
  expect(order).toEqual(["entry", "entry-claim", "vip"]);
  expect(screen.queryByTestId("player")).toBeNull();
});

it("广告拉起前展示当前剧目封面，缺图时不渲染入剧占位层", async () => {
  const runtime = {
    api: { entryAdStatus: vi.fn(() => new Promise<EntryAdStatus>(() => {})) },
    getSessionSubjectKey: () => "app:user",
    getCachedPublicCatalog: () => ({ dramas: [
      { id: "drama-1", firstEpisodeId: "episode-1", title: "一", description: "", coverUrl: "https://images.example/one.jpg", episodeCount: 1, tags: [], status: "completed" },
      { id: "drama-2", firstEpisodeId: "episode-2", title: "二", description: "", coverUrl: "https://images.example/two.jpg", episodeCount: 1, tags: [], status: "completed" },
    ] }),
  } as unknown as Runtime;
  const view = renderGate(runtime, "/watch/drama-2/episode-2");
  expect(view.container.querySelector(".playback-launch-preview img")).toHaveAttribute("src", "https://images.example/two.jpg");
  expect(screen.queryByTestId("player")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();

  view.unmount();
  const noCover = renderGate({ api: runtime.api, getSessionSubjectKey: runtime.getSessionSubjectKey } as Runtime,
    "/watch/drama-3/episode-1");
  expect(noCover.container.querySelector(".playback-launch-preview")).toBeNull();
  expect(screen.queryByTestId("player")).toBeNull();
});

it("未达标首次自动拉起，提前关闭后自动接续，完整结算两条才挂载播放器", async () => {
  let completed = 0;
  const entryAdStatus = vi.fn(async () => entryStatus(completed));
  const closeAd: Array<(result: { status: "cancelled" | "completed" }) => void> = [];
  const showEntryAd = vi.fn(() => new Promise<{ status: "cancelled" | "completed" }>(resolve => { closeAd.push(resolve); }));
  const claimReward = vi.fn(async () => {
    completed += 1;
    return { claimId: `claim-${completed}`, status: "granted", rewardType: "entry_progress", unlocked: false, dramaId: "", episodeId: "" } as const;
  });
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user",
    hasPendingAdClaim: () => false, showEntryAd, claimReward,
  } as unknown as Runtime;
  renderGate(runtime);

  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("player")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Watch ads before you start" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Watch next ad" })).toBeNull();
  await act(async () => { closeAd[0]({ status: "cancelled" }); });
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
  expect(claimReward).not.toHaveBeenCalled();
  expect(screen.queryByTestId("player")).toBeNull();

  await act(async () => { closeAd[1]({ status: "completed" }); });
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(3));
  expect(claimReward).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => { closeAd[2]({ status: "completed" }); });
  await waitFor(() => expect(screen.getByTestId("player")).toBeTruthy());
  expect(claimReward).toHaveBeenCalledTimes(2);
  expect(entryAdStatus).toHaveBeenCalledTimes(4);
});

it("广告失败停止自动重试并提供手动重试入口", async () => {
  let completed = 0;
  const showEntryAd = vi.fn()
    .mockResolvedValueOnce({ status: "failed" })
    .mockResolvedValue({ status: "completed" });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(completed, 1)) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd, claimReward: vi.fn(async () => { completed += 1; return { rewardType: "entry_progress" }; }),
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(/No ad is available right now/);
  expect(showEntryAd).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByTestId("player")).toBeTruthy());
  expect(showEntryAd).toHaveBeenCalledTimes(2);
});

it("原生结果未知时显示等待提示，生命周期恢复不会自动重拉", async () => {
  const showEntryAd = vi.fn().mockResolvedValue({ status: "unknown" });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(0, 1)) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(text("runtime.rewardedAdPending"));
  fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
  await act(async () => {});
  expect(showEntryAd).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("player")).toBeNull();
});

it("取消时服务端已确认展示达标，直接放行且不创建多余广告", async () => {
  let shown = 0;
  const showEntryAd = vi.fn(async () => { shown = 1; return { status: "cancelled" }; });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => ({ ...entryStatus(0, 1), countBy: "shown", shownCount: shown })) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByTestId("player");
  expect(showEntryAd).toHaveBeenCalledOnce();
});

it.each(["cancelled", "completed"] as const)("展示确认在广告回前台时已失效，%s 后读取服务器最新进度放行", async status => {
  const clock = new ServerClock();
  const confirmed = clock.bind({ ...entryStatus(0, 1), countBy: "shown" as const, shownCount: 1 }, new Date().toISOString(), performance.now(), 0, 1);
  let closeAd: ((result: { status: "cancelled" | "completed"; entryAdStatus: EntryAdStatus }) => void) | undefined;
  const entryAdStatus = vi.fn()
    .mockResolvedValueOnce({ ...entryStatus(0, 1), countBy: "shown", shownCount: 0 })
    .mockImplementation(async () => ({ ...entryStatus(0, 1), countBy: "shown", shownCount: 1 }));
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd: vi.fn(() => new Promise(resolve => { closeAd = resolve; })),
    claimReward: vi.fn(async () => ({ rewardType: "entry_progress", dramaId: "drama-1", entryAdStatus: confirmed })),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(runtime.showEntryAd).toHaveBeenCalledOnce());
  // 原生广告关闭前发生前后台切换，旧展示回包的本地截止点已失效，事实本身仍已入库。
  clock.invalidate();
  await act(async () => closeAd?.({ status, entryAdStatus: confirmed }));
  await screen.findByTestId("player");
  expect(entryAdStatus).toHaveBeenCalledTimes(2);
  expect(runtime.showEntryAd).toHaveBeenCalledOnce();
  expect(screen.queryByText(text("entryAd.statusError"))).toBeNull();
});

it("前台重新读取确认已达标时清除旧查询错误，不要求再点一次重试", async () => {
  const entryAdStatus = vi.fn()
    .mockRejectedValueOnce(new Error("test query interrupted"))
    .mockImplementation(async () => ({ ...entryStatus(0, 1), countBy: "shown", shownCount: 1 }));
  const runtime = { api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", showEntryAd: vi.fn() } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(text("entryAd.statusError"));
  fireEvent(window, new Event("pagehide"));
  fireEvent(window, new Event("pageshow"));
  await screen.findByTestId("player");
  expect(screen.queryByText(text("entryAd.statusError"))).toBeNull();
  expect(runtime.showEntryAd).not.toHaveBeenCalled();
});

it.each(["cancelled", "completed"] as const)("%s 结算补查期间迟到的前台信号不丢失恢复检查", async status => {
  const clock = new ServerClock();
  const confirmed = clock.bind({ ...entryStatus(0, 1), countBy: "shown" as const, shownCount: 1 }, new Date().toISOString(), performance.now(), 0, 1);
  let closeAd: ((value: { status: "cancelled" | "completed"; entryAdStatus: EntryAdStatus }) => void) | undefined;
  let finishQuery: ((value: EntryAdStatus) => void) | undefined;
  const ready = () => ({ ...entryStatus(0, 1), countBy: "shown" as const, shownCount: 1 });
  const entryAdStatus = vi.fn()
    .mockResolvedValueOnce({ ...entryStatus(0, 1), countBy: "shown", shownCount: 0 })
    .mockImplementationOnce(() => new Promise<EntryAdStatus>(resolve => { finishQuery = resolve; }))
    .mockImplementation(async () => ready());
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd: vi.fn(() => new Promise(resolve => { closeAd = resolve; })),
    claimReward: vi.fn(async () => ({ rewardType: "entry_progress", dramaId: "drama-1", entryAdStatus: confirmed })),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(runtime.showEntryAd).toHaveBeenCalledOnce());
  clock.invalidate();
  await act(async () => closeAd?.({ status, entryAdStatus: confirmed }));
  await waitFor(() => expect(entryAdStatus).toHaveBeenCalledTimes(2));
  // 查询仍在途时原生广告才通知回前台，旧查询被撤销，但此时广告流程仍持有 busy。
  fireEvent(window, new Event("pagehide"));
  fireEvent(window, new Event("pageshow"));
  await act(async () => finishQuery?.(ready()));
  await screen.findByTestId("player");
  expect(entryAdStatus).toHaveBeenCalledTimes(3);
  expect(runtime.showEntryAd).toHaveBeenCalledOnce();
});

it.each(["completed", "shown"] as const)("%s 取消补查被迟到前台通知撤销后，重查未达标仍自动接续", async countBy => {
  let closeAd: ((value: { status: "cancelled" }) => void) | undefined;
  let finishQuery: ((value: EntryAdStatus) => void) | undefined;
  const unmet = () => ({ ...entryStatus(0, 1), countBy, shownCount: 0 });
  const entryAdStatus = vi.fn()
    .mockResolvedValueOnce(unmet())
    .mockImplementationOnce(() => new Promise<EntryAdStatus>(resolve => { finishQuery = resolve; }))
    .mockImplementation(async () => unmet());
  const showEntryAd = vi.fn(() => new Promise(resolve => { closeAd = resolve; }));
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd, claimReward: vi.fn(),
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledOnce());
  await act(async () => closeAd?.({ status: "cancelled" }));
  await waitFor(() => expect(entryAdStatus).toHaveBeenCalledTimes(2));
  // 忙碌期间补查被作废后必须重新确认进度，不能停封面或按旧进度放行。
  fireEvent(window, new Event("pagehide"));
  fireEvent(window, new Event("pageshow"));
  await act(async () => finishQuery?.(unmet()));
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
  expect(entryAdStatus).toHaveBeenCalledTimes(3);
  expect(runtime.claimReward).not.toHaveBeenCalled();
  expect(screen.queryByTestId("player")).toBeNull();
  expect(screen.queryByText(text("entryAd.adCancelled"))).toBeNull();
});

it("广告在后台取消时不请求，回到前台未达标则自动接续", async () => {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  let closeAd: ((result: { status: "cancelled" }) => void) | undefined;
  const showEntryAd = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { closeAd = resolve; }))
    .mockImplementation(() => new Promise(() => {}));
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(0, 1)) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
  } as unknown as Runtime;
  renderGate(runtime);
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(1));
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    closeAd?.({ status: "cancelled" });
  });
  expect(showEntryAd).toHaveBeenCalledTimes(1);
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
});

it("存在待确认奖励时先补领，达标后不重复展示广告", async () => {
  let completed = 0;
  let pending = true;
  const showEntryAd = vi.fn();
  const retryPendingAdClaims = vi.fn(async () => { pending = false; completed = 1; return []; });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(completed, 1)) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => pending,
    retryPendingAdClaims, showEntryAd,
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByTestId("player");
  expect(retryPendingAdClaims).toHaveBeenCalledTimes(1);
  expect(showEntryAd).not.toHaveBeenCalled();
});

it("领奖后服务端进度未推进时记录故障并停止连续广告", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const showEntryAd = vi.fn(async () => ({ status: "completed" as const }));
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(0, 1)) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd, claimReward: vi.fn(async () => ({ rewardType: "entry_progress" })),
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(/couldn't confirm this ad/);
  expect(showEntryAd).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("player")).toBeNull();
  expect(log).toHaveBeenCalledWith({ event: "entry_ad_progress_not_advanced", error: "Entry ad claim did not advance daily progress" });
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("进度有效期异常时记录原因且不展示广告", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const showEntryAd = vi.fn();
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => ({ ...entryStatus(0, 1), validUntil: "invalid" })) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(/couldn't check your ad progress/);
  expect(showEntryAd).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith({ event: "entry_ad_status_invalid", error: "Entry ad progress has no future validity deadline" });
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("进度查询失败时保持播放器未挂载并允许重试", async () => {
  const entryAdStatus = vi.fn()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValueOnce({ enabled: false, completedCount: 0, requiredCount: 0 });
  const runtime = { api: { entryAdStatus }, getSessionSubjectKey: () => "app:user" } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(/couldn't check your ad progress/);
  expect(screen.queryByTestId("player")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByTestId("player")).toBeTruthy());
});

it("身份切换后立即撤下旧用户播放器并读取新用户进度", async () => {
  let subject = "app:first";
  let sessionChanged: (() => void) | undefined;
  let resolveSecond: ((status: EntryAdStatus) => void) | undefined;
  const entryAdStatus = vi.fn()
    .mockResolvedValueOnce(entryStatus(2))
    .mockImplementationOnce(() => new Promise<EntryAdStatus>(resolve => { resolveSecond = resolve; }));
  const showEntryAd = vi.fn(() => new Promise(() => {}));
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => subject,
    subscribeSessionState: (listener: () => void) => { sessionChanged = listener; return () => { sessionChanged = undefined; }; },
    hasPendingAdClaim: () => false, showEntryAd,
  } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByTestId("player");
  subject = "app:second";
  sessionChanged?.();
  await waitFor(() => expect(screen.queryByTestId("player")).toBeNull());
  resolveSecond?.(entryStatus(0));
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("heading", { name: "Watch ads before you start" })).toBeNull();
  expect(screen.queryByTestId("player")).toBeNull();
});

it("到达应用当天截止时间后保留播放器但封闭门禁，重新确认当日进度", async () => {
  vi.useFakeTimers();
  const entryAdStatus = vi.fn()
    .mockImplementationOnce(async () => new ServerClock().bind({ ...entryStatus(2), validUntil: new Date(Date.now() + 1000).toISOString() }, new Date().toISOString(), performance.now(), 0, 0))
    .mockImplementationOnce(async () => entryStatus(0));
  const showEntryAd = vi.fn(() => new Promise(() => {}));
  const runtime = { api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd } as unknown as Runtime;
  renderGate(runtime);
  await act(async () => { await Promise.resolve(); });
  const player = screen.getByTestId("player");
  expect(player).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByTestId("player")).toBe(player);
  expect(player).not.toBeVisible();
  expect(screen.queryByRole("heading", { name: "Watch ads before you start" })).toBeNull();
  expect(entryAdStatus).toHaveBeenCalledTimes(2);
  expect(showEntryAd).toHaveBeenCalledTimes(1);
});

it.each(["container_unavailable", "not_visible"])("挂载前原生隐藏不自动拉广告，%s 后仅真实前台切换恢复并重新读取进度", async reason => {
  const { ensureVisibilityTracking } = await import("../../platform/tiktok/lifecycle");
  const events = new Map<string, () => void>();
  const originalSDK = window.TTMinis;
  window.TTMinis = { on: (name: string, listener: () => void) => { events.set(name, listener); return name; }, off: () => {} } as unknown as import("../../platform/tiktok/types").TikTokMinisSDK;
  ensureVisibilityTracking(window.TTMinis);
  events.get("minis.hide")!();
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => entryStatus(0)) }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd: vi.fn().mockResolvedValueOnce({ status: "failed", reason }).mockImplementation(() => new Promise(() => {})),
  } as unknown as Runtime;
  try {
    renderGate(runtime);
    await act(async () => {});
    expect(runtime.showEntryAd).not.toHaveBeenCalled();
    await act(async () => events.get("minis.show")!());
    await waitFor(() => expect(runtime.showEntryAd).toHaveBeenCalledOnce());
    await screen.findByText(text("entryAd.adUnavailable"));
    await act(async () => events.get("minis.show")!());
    expect(runtime.showEntryAd).toHaveBeenCalledOnce();
    await act(async () => { events.get("minis.hide")!(); events.get("minis.show")!(); });
    await waitFor(() => expect(runtime.showEntryAd).toHaveBeenCalledTimes(2));
    expect(runtime.api.entryAdStatus).toHaveBeenCalledTimes(3);
  } finally { window.TTMinis = originalSDK; }
});

it("TikTok 版本过低时提示更新，入剧门禁保留返回入口且不反复拉起", async () => {
  const showEntryAd = vi.fn().mockResolvedValue({ status: "failed", reason: "client_outdated" });
  const runtime = { api: { entryAdStatus: vi.fn(async () => entryStatus(0)) }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd } as unknown as Runtime;
  renderGate(runtime);
  expect(await screen.findByText(text("runtime.rewardedAdUnavailable"))).toBeVisible();
  expect(screen.queryByRole("button", { name: text("common.retry") })).toBeNull();
  expect(screen.getByRole("button", { name: text("common.back") })).toBeVisible();
  expect(screen.queryByTestId("player")).toBeNull();
  fireEvent(window, new Event("pagehide"));
  fireEvent(window, new Event("pageshow"));
  await waitFor(() => expect(runtime.api.entryAdStatus).toHaveBeenCalledTimes(2));
  expect(showEntryAd).toHaveBeenCalledOnce();
});

it("50008 手动恢复先查新进度，只有该次用户操作带手动展示意图", async () => {
  const showEntryAd = vi.fn().mockResolvedValueOnce({ status: "failed", reason: "container_unavailable" }).mockImplementation(() => new Promise(() => {}));
  const runtime = { api: { entryAdStatus: vi.fn(async () => entryStatus(0)) }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd } as unknown as Runtime;
  renderGate(runtime);
  await screen.findByText(text("entryAd.adUnavailable"));
  expect(showEntryAd.mock.calls[0][2].userInitiated).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
  expect(runtime.api.entryAdStatus).toHaveBeenCalledTimes(2);
  expect(showEntryAd.mock.calls[1][2].userInitiated).toBe(true);
  expect(showEntryAd.mock.calls[1][2].isCurrent()).toBe(true);
});

it.each([true, false])("展示确认晚于回前台时仅恢复可恢复错误，50008=%s", async recoverable => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let shownCount = 0;
  const status = () => ({ ...entryStatus(0, 2), countBy: "shown" as const, shownCount });
  const ads: Array<{ close(): void; error(reason: unknown): void }> = [];
  const create = vi.fn(() => {
    let close!: (result: RewardedAdCloseResult) => void;
    let error!: (reason: unknown) => void;
    ads.push({ close: () => close({ isEnded: false }), error: reason => error(reason) });
    return { show: () => Promise.resolve(), onClose: (listener: typeof close) => { close = listener; },
      onError: (listener: typeof error) => { error = listener; }, offClose: vi.fn(), offError: vi.fn() };
  });
  const sdk = { canIUse: () => true, createRewardedVideoAd: create } as unknown as TikTokMinisSDK;
  let confirm!: () => void;
  const confirmation = new Promise<void>(resolve => { confirm = resolve; });
  // 与 Runtime 一致：真实适配器先返回广告结果，再等待并行发送的展示事实确认。
  const showEntryAd = vi.fn<Runtime["showEntryAd"]>(async (claim, _requireShowConfirmation, intent) => {
    const result = await showRewardedAd(sdk, claim.adUnitId, () => { shownCount++; }, undefined, undefined, intent);
    await confirmation;
    return { ...result, entryAdStatus: status() };
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => status()) }, getSessionSubjectKey: () => "app:user",
    hasPendingAdClaim: () => false, isFullscreenAdActive: () => hasPendingFullscreenAd(sdk), showEntryAd,
    claimReward: vi.fn(),
  } as unknown as Runtime;
  const view = renderGate(runtime);
  try {
    await waitFor(() => expect(shownCount).toBe(1));
    await act(async () => {
      fireEvent(window, new Event("pagehide"));
      ads[0].error({ errorCode: "101150000", subErrorCode: recoverable ? "50008" : "50101", errMsg: "ad display failed token=private" });
      ads[0].close();
    });
    expect(hasPendingFullscreenAd(sdk)).toBe(false);
    fireEvent(window, new Event("pageshow"));
    await act(async () => confirm());
    await waitFor(() => expect(runtime.api.entryAdStatus).toHaveBeenCalledTimes(2));
    if (recoverable) {
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(screen.queryByText(text("entryAd.adUnavailable"))).toBeNull();
      expect(showEntryAd.mock.calls[1][2]?.userInitiated).toBe(false);
    } else {
      await screen.findByText(text("entryAd.adUnavailable"));
      // 普通 SDK 故障仍保留错误，不因前台事件自动重试。
      fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
      await waitFor(() => expect(runtime.api.entryAdStatus).toHaveBeenCalledTimes(3));
      expect(create).toHaveBeenCalledOnce();
    }
    expect(runtime.claimReward).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", error: "ad display failed token=[REDACTED]" }));
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private");
  } finally {
    view.unmount();
    await act(async () => { ads.forEach(ad => ad.close()); });
  }
});

it.each([
  { busy: true, signal: "pageshow" }, { busy: true, signal: "minis.show" },
  { busy: false, signal: "pageshow" }, { busy: false, signal: "minis.show" },
])("50008 恢复查询被 $signal 替代时接续恢复且只展示一次，前台信号早于广告结果=$busy", async ({ busy, signal }) => {
  const nativeListeners = new Map<string, () => void>();
  const originalSDK = window.TTMinis;
  window.TTMinis = { on: (event: string, listener: () => void) => { nativeListeners.set(event, listener); return event; }, off: () => {} } as unknown as TikTokMinisSDK;
  let completeAd!: (result: { status: "failed"; reason: "container_unavailable" }) => void;
  const responses: Array<(status: EntryAdStatus) => void> = [];
  const entryAdStatus = vi.fn<Runtime["api"]["entryAdStatus"]>()
    .mockResolvedValueOnce(entryStatus(0))
    .mockImplementation(() => new Promise(resolve => responses.push(resolve)));
  const showEntryAd = vi.fn<Runtime["showEntryAd"]>()
    .mockImplementationOnce(() => new Promise(resolve => { completeAd = resolve; }))
    .mockImplementation(() => new Promise(() => {}));
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    isFullscreenAdActive: () => false, showEntryAd, claimReward: vi.fn(),
  } as unknown as Runtime;
  const view = renderGate(runtime);
  try {
    await waitFor(() => expect(showEntryAd).toHaveBeenCalledOnce());
    if (!busy) await act(async () => completeAd({ status: "failed", reason: "container_unavailable" }));
    fireEvent(window, new Event("pagehide"));
    fireEvent(window, new Event("pageshow"));
    if (busy) await act(async () => completeAd({ status: "failed", reason: "container_unavailable" }));
    await waitFor(() => expect(entryAdStatus).toHaveBeenCalledTimes(2));

    // 恢复查询未返回时，网页再次回前台或首次宿主前台证据会使旧查询失效。
    if (signal === "pageshow") {
      fireEvent(window, new Event("pagehide"));
      fireEvent(window, new Event("pageshow"));
    } else {
      await act(async () => nativeListeners.get("minis.show")!());
    }
    await waitFor(() => expect(entryAdStatus).toHaveBeenCalledTimes(3));
    await act(async () => responses[0](entryStatus(2)));
    expect(showEntryAd).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("player")).toBeNull();
    await act(async () => responses[1](entryStatus(0)));
    await waitFor(() => expect(showEntryAd).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(text("entryAd.adUnavailable"))).toBeNull();
    expect(showEntryAd.mock.calls[1][2]?.userInitiated).toBe(false);
    expect(entryAdStatus).toHaveBeenCalledTimes(3);
    expect(runtime.claimReward).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    window.TTMinis = originalSDK;
  }
});

it("50008 恢复查询真实失败后不沿用恢复意图自动展示，保留脱敏错误日志", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let rejectStatus!: (reason: Error) => void;
  const entryAdStatus = vi.fn<Runtime["api"]["entryAdStatus"]>()
    .mockResolvedValueOnce(entryStatus(0))
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectStatus = reject; }))
    .mockImplementation(async () => entryStatus(0));
  const showEntryAd = vi.fn<Runtime["showEntryAd"]>()
    .mockResolvedValueOnce({ status: "failed", reason: "container_unavailable" })
    .mockImplementation(() => new Promise(() => {}));
  const runtime = {
    api: { entryAdStatus }, getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false, showEntryAd,
  } as unknown as Runtime;
  const view = renderGate(runtime);
  try {
    await screen.findByText(text("entryAd.adUnavailable"));
    fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(entryAdStatus).toHaveBeenCalledTimes(2));
    await act(async () => rejectStatus(new Error("progress unavailable token=private")));
    await screen.findByText(text("entryAd.statusError"));
    fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(entryAdStatus).toHaveBeenCalledTimes(3));
    await screen.findByText(text("entryAd.statusError"));
    expect(showEntryAd).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledExactlyOnceWith({ event: "entry_ad_status_failed", error: "progress unavailable token=[REDACTED]" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private");
  } finally { view.unmount(); }
});

it.each(["50008", "50101"])("展示模式已确认达标，%s 故障且原生关闭后仍放行，不重复看广告或发奖", async subErrorCode => {
  let close!: (result: RewardedAdCloseResult) => void;
  let error!: (reason: unknown) => void;
  let confirmed!: () => void;
  const confirmation = new Promise<void>(resolve => { confirmed = resolve; });
  const create = vi.fn(() => ({
    show: () => Promise.resolve(),
    onClose: (listener: typeof close) => { close = listener; }, onError: (listener: typeof error) => { error = listener; },
    offClose: vi.fn(), offError: vi.fn(),
  }));
  const sdk = { canIUse: () => true, createRewardedVideoAd: create } as unknown as TikTokMinisSDK;
  let shownCount = 0;
  const status = () => ({ ...entryStatus(0, 1), countBy: "shown" as const, shownCount });
  const showEntryAd = vi.fn<Runtime["showEntryAd"]>(async (claim, _requireConfirmation, intent) => {
    const result = await showRewardedAd(sdk, claim.adUnitId, () => { shownCount++; }, undefined, undefined, intent);
    await confirmation;
    return { ...result, entryAdStatus: status() };
  });
  const runtime = {
    api: { entryAdStatus: vi.fn(async () => status()) },
    getSessionSubjectKey: () => "app:user", hasPendingAdClaim: () => false,
    showEntryAd, isFullscreenAdActive: () => hasPendingFullscreenAd(sdk), claimReward: vi.fn(),
  } as unknown as Runtime;
  const view = renderGate(runtime);
  try {
    await waitFor(() => expect(shownCount).toBe(1));
    await act(async () => {
      error({ errorCode: "101150000", subErrorCode, errMsg: "ad failure" });
      close({ isEnded: false });
    });
    expect(hasPendingFullscreenAd(sdk)).toBe(false);
    await act(async () => confirmed());
    await screen.findByTestId("player");
    expect(showEntryAd).toHaveBeenCalledOnce();
    expect(runtime.claimReward).not.toHaveBeenCalled();
  } finally { view.unmount(); close?.({ isEnded: false }); }
});
