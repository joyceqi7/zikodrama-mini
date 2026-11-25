import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { adPolicy } from "./config/adPolicy";
import { text } from "./copy";
import type { AdShow, BootstrapResult, EntryAdStatus, RewardClaim } from "./domain/types";
import { EntryAdGate } from "./pages/theater/EntryAdGate";
import { hasPendingFullscreenAd } from "./platform/tiktok/fullscreenAd";
import { RuntimeContext } from "./runtime/RuntimeContext";
import { createRuntime } from "./runtime/runtime";
import { createTikTokFixture } from "./test/tiktokFixture";

const lifecycleCleanups: Array<() => void> = [];

beforeEach(() => {
  // 每个场景独立创建页面运行时；释放其长期生命周期监听，避免失败夹具响应污染后续场景。
  for (const target of [document, window] as EventTarget[]) {
    const addEventListener = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      addEventListener(type, listener, options);
      if (["visibilitychange", "pagehide", "pageshow"].includes(type)) {
        lifecycleCleanups.push(() => target.removeEventListener(type, listener, options));
      }
    });
  }
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); },
    clear: () => entries.clear(), key: index => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  } satisfies Storage);
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
});

afterEach(() => {
  cleanup();
  lifecycleCleanups.splice(0).forEach(remove => remove());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.TTMinis;
});

/** entryHarness 贯通真实门禁、运行时与 HTTP 客户端，仅控制外部 API 和原生广告信号。 */
async function entryHarness(provider: "byteplus_web" | "tiktok_minis", countBy: "shown" | "completed", vip?: {
  /** active 指定观众进入剧场前已有 VIP，仍需独立完成入剧广告。 */
  active?: boolean;
  /** countdownSeconds 指定 VIP 弹窗的前台自动拉起倒计时。 */
  countdownSeconds?: number;
  /** entryRefresh 可延迟已看完入剧广告后的进度重查，参数是本次服务端进度快照。 */
  entryRefresh?(state: EntryAdStatus): Promise<Response>;
  /** refresh 控制广告回前台后的权益确认，首次启动仍立即返回初始状态。 */
  refresh(): Promise<Response>;
  /** offer 控制入剧达标后按需查询的 VIP 广告入口。 */
  offer(): Promise<Response>;
}) {
  const platform = createTikTokFixture();
  const lifecycle = new Map<string, { event: string; listener: () => void }>();
  let sequence = 0;
  platform.sdk.on = (event, listener) => {
    const id = String(++sequence);
    lifecycle.set(id, { event, listener });
    return id;
  };
  platform.sdk.off = (_event, id) => lifecycle.delete(id);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const ads: Array<{ shown(): void; close(isEnded: boolean): void; show: ReturnType<typeof vi.fn> }> = [];
  const createAd = vi.spyOn(platform.sdk, "createRewardedVideoAd").mockImplementation(() => {
    let close!: (result: { isEnded: boolean }) => void;
    let shown!: () => void;
    const displayed = new Promise<void>(resolve => { shown = resolve; });
    const show = vi.fn(() => displayed);
    // 保留已排队的回调引用，模拟解绑后仍送达的重复结果，验证业务幂等而非依赖替身过滤。
    ads.push({ show, shown: () => shown(), close: isEnded => close({ isEnded }) });
    return { show, onClose: listener => { close = listener; }, offClose: vi.fn(), onError: vi.fn(), offError: vi.fn() };
  });
  window.TTMinis = platform.sdk;

  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const bootstrap: BootstrapResult = {
    applicationId: "application", tiktokAppId: "test-app", visitorId: "visitor", visitorToken: "fixture-token",
    appName: "Test Drama", logoUrl: "", complianceBaseUrl: "", identityState: "tiktok_authenticated",
    playbackSdk: { provider, channel: "byteplus", capabilities: { mediaPreload: false } },
    vipState: { active: !!vip?.active, adCount: vip?.active ? 3 : 0, requiredCount: vip ? 3 : 1, progressDate: "today",
      ...(vip?.active ? { validUntil: deadline } : {}) },
    monetization: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: !!vip, requireBeforePlayback: !!vip, entryAdCountdownSeconds: vip?.countdownSeconds ?? 0,
        requiredAdCount: vip ? 3 : 1, title: "", content: "" } },
  };
  const shows: AdShow[] = [];
  const claims: Array<{ claimId: string; completedAdUnitId: string; isEnded: boolean }> = [];
  const entryState = (): EntryAdStatus => ({ enabled: true, scope: "user_drama", countBy,
    shownCount: shows.length, completedCount: claims.length, requiredCount: 1, progressDate: "today", validUntil: deadline,
    offer: { offerId: "entry-offer", adUnitId: "entry-placement", kind: "rewarded_entry" } });
  const response = (data: unknown) => new Response(JSON.stringify({ serverTime: new Date().toISOString(), data }));
  let vipReads = 0;
  let entryReads = 0;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input), "https://fixture.invalid").pathname;
    if (path.endsWith("/session") || path.endsWith("/open/app-config")) return response(bootstrap);
    if (path.endsWith("/me/vip")) return ++vipReads > 1 && vip ? vip.refresh() : response(bootstrap.vipState);
    if (path.endsWith("/me/vip/offer") && vip) return vip.offer();
    if (path.endsWith("/open/catalog")) return response({ tiktokAppId: "test-app", dramas: [] });
    if (path.endsWith("/play/entry")) {
      entryReads++;
      return response({ entry: {
        target: { dramaId: "drama-1", episodeId: "episode-1" },
        drama: { id: "drama-1", coverUrl: "" }, episode: { id: "episode-1", dramaId: "drama-1", posterUrl: "" },
        entryAdStatus: entryState(), vipState: bootstrap.vipState,
      } });
    }
    if (path.endsWith("/me/entry-ad")) return ++entryReads > 1 && vip?.entryRefresh ? vip.entryRefresh(entryState()) : response(entryState());
    if (path.endsWith("/me/entry-ad/shows")) {
      shows.push(JSON.parse(String(init?.body)) as AdShow);
      return response({ accepted: true, entryAdStatus: entryState() });
    }
    if (path.endsWith("/reward-grants")) {
      const claim = JSON.parse(String(init?.body)) as typeof claims[number];
      claims.push(claim);
      return response({ claimId: claim.claimId, status: "granted", rewardType: "entry_progress",
        unlocked: false, dramaId: "drama-1", episodeId: "", entryAdStatus: entryState() });
    }
    if (path.endsWith("/dramas/drama-1")) return response({ id: "drama-1", title: "Test Drama", description: "",
      coverUrl: "", firstEpisodeId: "episode-1", episodeCount: 1, status: "ongoing", tags: [], episodes: [] });
    if (path.endsWith("/metrics")) return response({ accepted: true });
    throw new Error(`测试未声明的 API 路径: ${path}`);
  }));
  const runtime = createRuntime();
  await runtime.bootstrap();
  const displayedClaims = vi.spyOn(runtime, "showEntryAd");
  const watchVIPAd = vi.spyOn(runtime, "watchVIPAd");
  const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={["/watch/drama-1/episode-1"]}>
    <Routes><Route path="/watch/:dramaId/:episodeId" element={<EntryAdGate><div data-testid="player" /></EntryAdGate>} /></Routes>
  </MemoryRouter></RuntimeContext.Provider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(createAd).toHaveBeenCalledOnce();

  return { runtime, sdk: platform.sdk, createAd, displayedClaims, watchVIPAd, ads, shows, claims, unmount: view.unmount,
    emit(event: "minis.hide" | "minis.show") {
      [...lifecycle.values()].filter(value => value.event === event).forEach(value => value.listener());
    },
    pageVisible(visible: boolean) {
      visibility = visible ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event(visible ? "pageshow" : "pagehide"));
    },
  };
}

const scenarios = (["byteplus_web", "tiktok_minis"] as const).flatMap(provider =>
  (["shown", "completed"] as const).flatMap(countBy =>
    (["native", "document"] as const).map(signal => ({ provider, countBy, signal }))));

it.each(scenarios)("$provider/$countBy/$signal 连续恢复前台不提前取消或重拉，原生完播仅展示和领奖一次", async ({ provider, countBy, signal }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await entryHarness(provider, countBy);
  for (let cycle = 0; cycle < 3; cycle++) {
    await act(async () => {
      if (signal === "native") { h.emit("minis.hide"); h.emit("minis.hide"); }
      else h.pageVisible(false);
      await vi.advanceTimersByTimeAsync(60_000);
      if (signal === "native") { h.emit("minis.show"); h.emit("minis.show"); }
      else h.pageVisible(true);
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(h.createAd).toHaveBeenCalledOnce();
    expect(h.ads[0].show).toHaveBeenCalledOnce();
    expect(h.runtime.isFullscreenAdActive?.()).toBe(true);
    expect(h.shows).toHaveLength(0);
    expect(h.claims).toHaveLength(0);
    expect(screen.queryByTestId("player")).toBeNull();
  }
  await act(async () => { h.ads[0].shown(); await vi.advanceTimersByTimeAsync(0); });
  expect(h.shows).toHaveLength(1);
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => { h.ads[0].close(true); h.ads[0].close(true); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByTestId("player")).toBeInTheDocument();
  expect(h.claims).toHaveLength(1);
  expect(h.claims[0]).toMatchObject({ claimId: h.shows[0].eventId, completedAdUnitId: "entry-placement", isEnded: true });
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(errors).not.toHaveBeenCalled();
});

/** vipHandoffResponses 独立控制入口与权益响应顺序，不依赖计时器碰巧先后返回。 */
function vipHandoffResponses(active = false) {
  const response = (data: unknown) => new Response(JSON.stringify({ serverTime: new Date().toISOString(), data }));
  const state = { active, adCount: active ? 3 : 0, requiredCount: 3, progressDate: "today",
    ...(active ? { validUntil: new Date(Date.now() + 3_600_000).toISOString() } : {}) };
  let confirmOffer!: () => void;
  const offered = new Promise<void>(resolve => { confirmOffer = resolve; });
  let confirmVIP!: () => void;
  let rejectVIP!: (reason: Error) => void;
  const refreshed = new Promise<void>((resolve, reject) => { confirmVIP = resolve; rejectVIP = reject; });
  const offer = vi.fn(async () => {
    await offered;
    return response({ offer: { offerId: "vip-offer", kind: "rewarded_vip", adUnitId: "vip-placement" } });
  });
  const refresh = vi.fn(async () => { await refreshed; return response(state); });
  return { active, offer, refresh, confirmOffer, confirmVIP, rejectVIP, state, response };
}

it.each(scenarios)("$provider/$countBy/$signal 入剧后 VIP 弹窗在迟到的前台重查期间保持同一次展示和剩余倒计时", async ({ provider, countBy, signal }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const vip = vipHandoffResponses();
  let confirmEntry!: () => void;
  const entryChecked = new Promise<void>(resolve => { confirmEntry = resolve; });
  const h = await entryHarness(provider, countBy, { ...vip, countdownSeconds: 3,
    entryRefresh: async state => { await entryChecked; return vip.response(state); },
  });
  await act(async () => { h.ads[0].shown(); h.ads[0].close(true); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  const dialog = screen.getByRole("dialog");
  const backdrop = dialog.parentElement;
  const title = screen.getByRole("heading", { name: text("vip.defaultTitle") });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  const countdown = screen.getByText(text("vip.adCountdown", { seconds: 2 }));
  await act(async () => {
    if (signal === "native") { h.emit("minis.hide"); h.emit("minis.show"); }
    else { h.pageVisible(false); h.pageVisible(true); }
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.getAllByRole("dialog")).toEqual([dialog]);
  expect(dialog).toBeVisible();
  expect(dialog.parentElement).toBe(backdrop);
  expect(title).toBeVisible();
  expect(countdown).toBeVisible();
  expect(countdown).toHaveTextContent(text("vip.adCountdown", { seconds: 2 }));
  expect(screen.getByRole("button", { name: text("vip.watchAd") })).toBeDisabled();
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("player")).toBeNull();

  await act(async () => { vip.confirmVIP(); await vi.advanceTimersByTimeAsync(1_000); });
  expect(dialog).toBeVisible();
  expect(countdown).toHaveTextContent(text("vip.adCountdown", { seconds: 2 }));
  expect(h.watchVIPAd).not.toHaveBeenCalled();
  await act(async () => { confirmEntry(); vip.confirmOffer(); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(countdown).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(h.createAd).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(h.createAd).toHaveBeenCalledTimes(2);
  expect(h.watchVIPAd).toHaveBeenCalledOnce();
  expect(h.claims).toHaveLength(1);
  expect(errors).not.toHaveBeenCalled();
});

it.each(scenarios)("$provider/$countBy/$signal 已有 VIP 看完入剧广告后正常确认权益不闪报错，随后进入免费剧集", async ({ provider, countBy, signal }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const vip = vipHandoffResponses(true);
  const h = await entryHarness(provider, countBy, vip);
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("player")).toBeNull();
  await act(async () => {
    h.ads[0].shown();
    if (signal === "native") { h.emit("minis.hide"); h.emit("minis.show"); }
    else { h.pageVisible(false); h.pageVisible(true); }
    h.ads[0].close(true);
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(h.runtime.getAdExperience()).toMatchObject({ refreshRequired: true, vipState: { active: true } });
  expect(screen.queryByRole("status", { busy: true })).toBeNull();
  expect(screen.queryByTestId("player")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: text("common.retry") })).toBeNull();
  expect(screen.queryAllByText(text("apiErrors.responseUnconfirmed"))).toHaveLength(0);
  await act(async () => { vip.confirmVIP(); await vi.advanceTimersByTimeAsync(10); });
  expect(screen.getByTestId("player")).toBeVisible();
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(h.claims).toHaveLength(1);
  expect(h.shows).toHaveLength(1);
  expect(h.watchVIPAd).not.toHaveBeenCalled();
  expect(vip.offer).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

it.each(scenarios)("$provider/$countBy/$signal 入剧完播后权益重查晚于 VIP 入口，确认成功自动衔接首条 VIP 广告", async ({ provider, countBy, signal }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const vip = vipHandoffResponses();
  const h = await entryHarness(provider, countBy, vip);
  await act(async () => { h.ads[0].shown(); h.ads[0].close(true); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(vip.offer).toHaveBeenCalledOnce();
  await act(async () => {
    if (signal === "native") { h.emit("minis.hide"); h.emit("minis.show"); }
    else { h.pageVisible(false); h.pageVisible(true); }
    vip.confirmOffer();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.runtime.getAdExperience().refreshRequired).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(h.watchVIPAd).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "vip_rewarded_ad_deferred", error: "VIP state refresh is in progress" }));

  await act(async () => { vip.confirmVIP(); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(h.runtime.getAdExperience().refreshRequired).toBe(false);
  expect(screen.queryByText(text("apiErrors.responseUnconfirmed"))).toBeNull();
  expect(h.createAd).toHaveBeenCalledTimes(2);
  expect(h.createAd).toHaveBeenLastCalledWith({ adUnitId: "vip-placement" });
  expect(h.watchVIPAd).toHaveBeenCalledTimes(2);
  expect(h.claims).toHaveLength(1);
  expect(h.shows).toHaveLength(1);
  expect(screen.queryByTestId("player")).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});

it.each([false, true].flatMap(active => (["failed", "leave"] as const).map(outcome => ({ active, outcome }))))("VIP 已生效=$active，入剧后等待权益确认时 $outcome，不误拉广告；真实故障可重试恢复", async ({ active, outcome }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const vip = vipHandoffResponses(active);
  const h = await entryHarness("tiktok_minis", "completed", vip);
  await act(async () => { h.ads[0].shown(); h.ads[0].close(true); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { h.emit("minis.hide"); h.emit("minis.show"); vip.confirmOffer(); await vi.advanceTimersByTimeAsync(0); });
  if (outcome === "leave") {
    h.unmount();
    await act(async () => { vip.confirmVIP(); await vi.advanceTimersByTimeAsync(5_000); });
    expect(h.createAd).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    return;
  }

  await act(async () => {
    vip.rejectVIP(new Error("vip refresh disconnected token=private-value https://private.example/vip"));
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(screen.getAllByText(text("apiErrors.networkUnavailable"))).not.toHaveLength(0);
  expect(warn).toHaveBeenCalledWith({ event: "vip_state_refresh_failed", error: "vip refresh disconnected token=[REDACTED] [URL]" });
  expect(JSON.stringify([...errors.mock.calls, ...warn.mock.calls])).not.toContain("private-value");
  expect(JSON.stringify([...errors.mock.calls, ...warn.mock.calls])).not.toContain("private.example");
  vip.refresh.mockImplementation(async () => vip.response(vip.state));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: text("common.retry") })); await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(h.createAd).toHaveBeenCalledTimes(active ? 1 : 2);
  if (active) expect(screen.getByTestId("player")).toBeVisible();
  expect(screen.queryByText(text("apiErrors.networkUnavailable"))).toBeNull();
  expect(h.claims).toHaveLength(1);
});

it.each(scenarios.filter(value => value.signal === "native"))("$provider/$countBy 超时及手动重试不重拉，迟到完播仍以原 ClaimID 补领一次", async ({ provider, countBy }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await entryHarness(provider, countBy);
  const originalClaim: RewardClaim = h.displayedClaims.mock.calls[0][0];
  await act(async () => { await vi.advanceTimersByTimeAsync(adPolicy.rewardedShowTimeoutMs); });
  expect(screen.getByText(text("runtime.rewardedAdPending"))).toBeInTheDocument();
  expect(h.runtime.isFullscreenAdActive?.()).toBe(false);
  expect(hasPendingFullscreenAd(h.sdk)).toBe(true);
  for (let attempt = 0; attempt < 3; attempt++) {
    await act(async () => {
      h.emit("minis.hide"); h.pageVisible(false); h.emit("minis.show"); h.pageVisible(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.createAd).toHaveBeenCalledOnce();
    expect(h.claims).toHaveLength(0);
    expect(h.shows).toHaveLength(0);
    expect(screen.queryByTestId("player")).toBeNull();
  }
  await act(async () => {
    h.ads[0].shown(); await vi.advanceTimersByTimeAsync(0);
    h.ads[0].close(true); h.ads[0].close(true);
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.getByTestId("player")).toBeInTheDocument();
  expect(h.claims).toHaveLength(1);
  expect(h.claims[0]).toMatchObject({ claimId: originalClaim.claimId, completedAdUnitId: originalClaim.adUnitId, isEnded: true });
  expect(h.shows).toHaveLength(1);
  expect(h.shows[0].eventId).toBe(originalClaim.claimId);
  expect(h.createAd).toHaveBeenCalledOnce();
  expect(hasPendingFullscreenAd(h.sdk)).toBe(false);
  expect(h.runtime.hasPendingAdClaim()).toBe(false);
  expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_timeout", stage: "show", outcome: "unknown" }));
});
