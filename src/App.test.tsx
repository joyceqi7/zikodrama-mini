import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { App } from "./App";
import type { AdExperience, ClaimResult, DramaDetail, HomePayload, HomeSections, PlayResolveResult } from "./domain/types";
import { text } from "./copy";
import { createRuntime, type Runtime, type RuntimeSessionState } from "./runtime/runtime";
import { LocalLibraryStore } from "./domain/localLibrary";
import { ApiError } from "./api/httpMiniDramaApi";
import type { PlaybackCallbacks, PlaybackEngine } from "./player/playbackEngine";
import { createTikTokFixture } from "./test/tiktokFixture";
import { coverLoader } from "./components/coverLoader";
import * as theaterModule from "./runtime/theaterModule";
import { startApplication } from "./runtime/startup";

const mediaPreconnect = 'link[rel="preconnect"][href="https://vod.tkdrama.site"]';

// 手动通知列表底部可见，验证自动翻页而不依赖 jsdom 的布局能力。
function observeCatalogBottom() {
  let notify: (() => void) | undefined;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      notify = () => this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect() { notify = undefined; }
  });
  return async () => {
    await waitFor(() => expect(notify).toBeDefined());
    await act(async () => { notify?.(); notify?.(); });
  };
}

afterEach(() => {
  cleanup();
  document.head.querySelectorAll(mediaPreconnect).forEach(link => link.remove());
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.TTMinis;
  window.history.replaceState({}, "", "/");
});

it("普通入口首屏直接挂载已载入的首页组件，登录在后台完成", async () => {
  const runtime = runtimeFor();
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  let finish!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const { SquarePage } = await import("./pages/square");
  render(<App runtime={runtime} initialHomePage={SquarePage} />);

  expect(screen.getByRole("heading", { name: "Drama Minis" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "More Drama" })).toBeVisible();
  expect(await screen.findByRole("link", { name: /Campaign drama/ })).toBeVisible();
  await act(async () => finish());
});

it.each([false, true])("React 挂载前登录已完成=%s 时复用同一启动任务，StrictMode 不重新登录或准备播放器", async completed => {
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  const runtime = runtimeFor();
  let finish!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  runtime.preparePlayback = vi.fn(async () => undefined);
  const startup = startApplication(runtime, true);
  if (completed) { finish(); await startup.bootstrap; }

  render(<StrictMode><App runtime={runtime} startup={startup} /></StrictMode>);
  if (!completed) {
    expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
    await act(async () => finish());
  }
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
  expect(runtime.preparePlayback).toHaveBeenCalledOnce();
});

it("提前登录失败在挂载后保留固定提示，只有用户重试才重建封闭身份和播放器任务", async () => {
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  const runtime = runtimeFor();
  let state: RuntimeSessionState = "recovery_required";
  runtime.getSessionState = () => state;
  runtime.bootstrap = vi.fn().mockRejectedValue(new Error("startup unavailable token=private-value"));
  runtime.recoverSession = vi.fn(async () => { state = "ready"; });
  runtime.preparePlayback = vi.fn().mockRejectedValueOnce(new Error("SDK unavailable token=private-sdk"))
    .mockResolvedValue(undefined);
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const startup = startApplication(runtime, true);
    await expect(startup.bootstrap).rejects.toThrow("startup unavailable");
    await expect(startup.playback).rejects.toThrow("SDK unavailable");
    render(<StrictMode><App runtime={runtime} startup={startup} /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveTextContent(text("app.initializeError"));
    expect(screen.queryByText(/private-value|private-sdk/)).not.toBeInTheDocument();
    expect(runtime.bootstrap).toHaveBeenCalledOnce();
    expect(runtime.recoverSession).not.toHaveBeenCalled();
    expect(runtime.preparePlayback).toHaveBeenCalledOnce();
    expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
    expect(logging.mock.calls.filter(([entry]) => entry.event === "app_initialize_failed")).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "player_prepare_failed", error: "SDK unavailable token=[REDACTED]" }));

    fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
    await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
    expect(runtime.recoverSession).toHaveBeenCalledOnce();
    expect(runtime.bootstrap).toHaveBeenCalledOnce();
    expect(runtime.preparePlayback).toHaveBeenCalledTimes(2);
  } finally { logging.mockRestore(); warning.mockRestore(); }
});

it("提前播放器准备失败不阻断成功身份，StrictMode 挂载与路由交接不会隐式重试 SDK", async () => {
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  const runtime = runtimeFor();
  runtime.preparePlayback = vi.fn(async () => { throw new Error("SDK unavailable"); });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const startup = startApplication(runtime, true);
    await startup.bootstrap;
    await expect(startup.playback).rejects.toThrow("SDK unavailable");
    render(<StrictMode><App runtime={runtime} startup={startup} /></StrictMode>);
    await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
    expect(runtime.bootstrap).toHaveBeenCalledOnce();
    expect(runtime.preparePlayback).toHaveBeenCalledOnce();
    expect(warning.mock.calls.filter(([entry]) => entry.event === "player_prepare_failed")).toHaveLength(1);
  } finally { warning.mockRestore(); }
});

it("另一个 Runtime 的提前任务不能放行当前身份或阻止当前播放器准备", async () => {
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  const previous = runtimeFor();
  const startup = startApplication(previous, true);
  await startup.bootstrap;
  const current = runtimeFor();
  let finish!: () => void;
  current.bootstrap = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  current.preparePlayback = vi.fn(async () => undefined);
  render(<App runtime={current} startup={startup} />);
  expect(current.bootstrap).toHaveBeenCalledOnce();
  expect(current.preparePlayback).toHaveBeenCalledOnce();
  expect(current.api.resolvePlay).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(current.api.resolvePlay).toHaveBeenCalled());
});

it("首页复用提前登录任务但播放器仍在挂载 1200ms 后准备", async () => {
  vi.useFakeTimers();
  try {
    const runtime = runtimeFor();
    runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
    runtime.preparePlayback = vi.fn(async () => undefined);
    const startup = startApplication(runtime, false);
    await startup.bootstrap;
    render(<StrictMode><App runtime={runtime} startup={startup} /></StrictMode>);
    await act(async () => vi.advanceTimersByTimeAsync(1_199));
    expect(runtime.preparePlayback).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(runtime.preparePlayback).toHaveBeenCalledOnce();
    expect(runtime.bootstrap).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("主流程：首页浏览 -> 选剧 -> 登录完成 -> 验权播放", async () => {
  const runtime = runtimeFor();
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  runtime.preparePlayback = vi.fn(async () => {});
  render(<App runtime={runtime} />);
  fireEvent.click(await screen.findByRole("link", { name: /Campaign drama/ }));
  expect(window.location.hash).toBe("#/watch/campaign-drama/campaign-episode");
  expect(document.head.querySelector(mediaPreconnect)).toHaveAttribute("crossorigin", "anonymous");
  expect(runtime.preparePlayback).toHaveBeenCalledOnce();
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  expect(runtime.localLibrary.follows).not.toHaveBeenCalled();
  expect(runtime.localLibrary.history).not.toHaveBeenCalled();
  await act(async () => complete());
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
});

it("首次点剧期间登录完成，原卡片接住松手后的点击并发起验权", async () => {
  const runtime = runtimeFor();
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  let finish!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<App runtime={runtime} />);

  const originalCard = (await screen.findByText(drama.title)).closest(".drama-card")!;
  fireEvent.pointerDown(originalCard, { button: 0, pointerType: "touch" });
  await act(async () => finish());
  expect(screen.getByRole("link", { name: /Campaign drama/ })).toBe(originalCard);
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  fireEvent.pointerUp(originalCard, { button: 0, pointerType: "touch" });
  fireEvent.click(originalCard);
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalledWith(drama.id, drama.firstEpisodeId));
});

it("已登录首页点剧立即准备播放器，同一启动的定时准备不重复调用", async () => {
  vi.useFakeTimers();
  try {
    const runtime = runtimeFor();
    runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
    runtime.preparePlayback = vi.fn(async () => {});
    render(<App runtime={runtime} />);
    await act(async () => {});
    expect(runtime.preparePlayback).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("link", { name: /Campaign drama/ })));
    expect(runtime.preparePlayback).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1_200));
    expect(runtime.preparePlayback).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])("登录就绪=%s 时按下首页卡片准备剧场、海报和媒体连接", async ready => {
  const poster = "https://images.example/entry-poster.jpg";
  const cardDrama = { ...drama, firstEpisodePosterUrl: poster };
  const runtime = runtimeFor();
  if (!ready) runtime.bootstrap = vi.fn(() => new Promise<void>(() => {}));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [cardDrama] }));
  runtime.resolvePlaybackEntry = vi.fn();
  const prepare = vi.spyOn(theaterModule, "preloadTheaterModule");
  const requestCover = vi.spyOn(coverLoader, "request");
  try {
    render(<App runtime={runtime} />);
    const card = await screen.findByRole("link", { name: /Campaign drama/ });
    expect(prepare).not.toHaveBeenCalled();
    expect(document.head.querySelector(mediaPreconnect)).toBeNull();
    const press = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    fireEvent(card, press);
    expect(prepare).toHaveBeenCalledOnce();
    expect(requestCover).toHaveBeenCalledWith(poster, "high", true);
    expect(document.head.querySelector(mediaPreconnect)).toHaveAttribute("crossorigin", "anonymous");
    fireEvent(card, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(document.head.querySelectorAll(mediaPreconnect)).toHaveLength(1);
    expect(window.location.hash).toBe("");
    expect(runtime.resolvePlaybackEntry).not.toHaveBeenCalled();
    expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
    if (!ready) expect(runtime.localLibrary.history).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    requestCover.mockRestore();
  }
});

it("登录失败保留公开目录，用户重试后进入所选剧目", async () => {
  const runtime = runtimeFor();
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  runtime.bootstrap = vi.fn().mockRejectedValueOnce(new ApiError("SDK unavailable", 503, "identity_unavailable")).mockResolvedValue(undefined);
  render(<App runtime={runtime} />);
  await screen.findByRole("button", { name: text("common.retry") });
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: /Campaign drama/ }));
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
  expect(runtime.bootstrap).toHaveBeenCalledTimes(2);
});

it("公开目录失败保留同一首页并支持独立重试，错误日志保留原因且脱敏", async () => {
  const runtime = runtimeFor();
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  runtime.loadPublicCatalog = vi.fn().mockRejectedValueOnce(new Error("Catalog offline token=private-value")).mockResolvedValueOnce({ dramas: [drama] });
  render(<App runtime={runtime} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reload titles" }));
  expect(await screen.findByText("Campaign drama")).toBeInTheDocument();
  expect(runtime.api.discover).not.toHaveBeenCalled();
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
  expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "public_catalog_load_failed", error: "Catalog offline token=[REDACTED]" }));
  logging.mockRestore();
});

const drama: DramaDetail = {
  id: "campaign-drama",
  firstEpisodeId: "campaign-episode",
  title: "Campaign drama",
  description: "",
  coverUrl: "",
  episodeCount: 1,
  tags: [],
  status: "ongoing",
  episodes: [{
    id: "campaign-episode",
    dramaId: "campaign-drama",
    number: 1,
    title: "Episode 1",
    description: "",
    posterUrl: "",
    durationSeconds: 60,
    accessMode: "rewarded",
  }],
};

const unavailable: PlayResolveResult = {
  status: "unavailable",
};

const inactiveExperience = {
  vipState: {
    active: false,
    adCount: 0,
    requiredCount: 5,
    progressDate: "2026-07-29",
  },
  monetizationPolicy: {
    status: "enabled",
    vip: { enabled: false },
  },
} as unknown as AdExperience;

function runtimeFor(launchTarget?: { dramaId: string; episodeId: string }): Runtime {
  return {
    bootstrap: vi.fn(async () => undefined),
    getVisitorID: () => "fixture-visitor",
    getApplicationBrand: () => ({ name: "Drama Minis", logoUrl: "" }),
    getLaunchTarget: () => launchTarget,
    getAdExperience: () => inactiveExperience,
    subscribeAdExperience: () => () => undefined,
    api: {
      entryAdStatus: vi.fn(async () => ({ enabled: false, completedCount: 0, requiredCount: 0 })),
      home: vi.fn(async () => ({ dramas: [drama] })),
      discover: vi.fn(async () => ({ items: [drama], tags: [] })),
      drama: vi.fn(async () => drama),
      resolvePlay: vi.fn(async () => unavailable),
    },
    localLibrary: {
      history: vi.fn(() => []),
      follows: vi.fn(() => []),
      continueWatching: vi.fn(() => []),
      isFollowing: vi.fn(() => false),
      setFollow: vi.fn(),
      progress: vi.fn(),
      recordProgress: vi.fn(),
    },
  } as unknown as Runtime;
}

it("首页 VIP 固定入口在身份就绪且有可用规则时展示，并通过弹窗领取当日权益", async () => {
  const runtime = runtimeFor();
  const offer = { offerId: "vip-offer", adUnitId: "vip-ad", kind: "rewarded_vip" as const };
  let experience: AdExperience = {
    ...inactiveExperience,
    vipOffer: offer,
    vipState: { active: false, adCount: 0, requiredCount: 2, progressDate: "2026-09-30" },
    monetizationPolicy: {
      status: "enabled", strategy: "rules", freeEpisodeCount: 1,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 2, title: "", content: "" },
    },
  };
  const listeners = new Set<() => void>();
  runtime.getAdExperience = () => experience;
  runtime.subscribeAdExperience = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  runtime.watchVIPAd = vi.fn(async () => {
    const adCount = experience.vipState.adCount + 1;
    const vipState = { ...experience.vipState, active: adCount === 2, adCount };
    experience = { ...experience, vipState };
    listeners.forEach(listener => listener());
    return { claimId: "claim-vip", status: "granted", unlocked: false, dramaId: "", episodeId: "",
      rewardType: "vip_progress", vipState } satisfies ClaimResult;
  });
  let finishBootstrap!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { finishBootstrap = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));

  render(<App runtime={runtime} />);
  expect(screen.queryByRole("button", { name: text("vip.entry") })).not.toBeInTheDocument();
  await act(async () => finishBootstrap());
  const trigger = await screen.findByRole("button", { name: text("vip.entry") });
  expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  expect(runtime.watchVIPAd).not.toHaveBeenCalled();

  fireEvent.click(trigger);
  expect(screen.getByRole("dialog")).toHaveTextContent(text("vip.sponsoredProgress", { completed: 0, required: 2 }));
  expect(screen.getByRole("main")).toHaveAttribute("inert");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") })); });
  expect(runtime.watchVIPAd).toHaveBeenCalledWith(undefined, expect.objectContaining({ userInitiated: true, isCurrent: expect.any(Function) }));
  expect(screen.getByRole("dialog")).toHaveTextContent(text("vip.sponsoredProgress", { completed: 1, required: 2 }));
  fireEvent.click(screen.getByRole("button", { name: text("vip.closeOffer") }));
  fireEvent.click(screen.getByRole("button", { name: text("vip.entry") }));
  expect(screen.getByRole("dialog")).toHaveTextContent(text("vip.sponsoredProgress", { completed: 1, required: 2 }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") })); });
  expect(screen.getByRole("dialog")).toHaveTextContent(text("vip.activeToday"));
  fireEvent.click(screen.getByRole("button", { name: text("vip.startWatching") }));
  await waitFor(() => expect(screen.getByRole("button", { name: text("vip.entryActive") })).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("没有可用 VIP 规则时首页不展示固定入口", async () => {
  render(<App runtime={runtimeFor()} />);
  await screen.findByText("Campaign drama");
  expect(screen.queryByRole("button", { name: text("vip.entry") })).not.toBeInTheDocument();
});

it("opens a campaign target immediately without a global VIP gate", async () => {
  const runtime = runtimeFor({
    dramaId: "campaign-drama",
    episodeId: "campaign-episode",
  });

  render(<App runtime={runtime} />);

  await waitFor(() => {
    expect(window.location.hash).toBe("#/watch/campaign-drama/campaign-episode");
  });
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
});

it("缺少公开目录的兼容入口不显示品牌等待页，启动失败后仍可重试进入首页", async () => {
  const runtime = runtimeFor();
  let fail!: (reason: Error) => void;
  runtime.bootstrap = vi.fn()
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
    .mockResolvedValue(undefined);
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { container } = render(<App runtime={runtime} />);
    expect(container).toBeEmptyDOMElement();
    await act(async () => fail(new Error("Startup failed")));
    expect(screen.getByRole("alert")).toHaveTextContent(text("app.unableToStart"));
    fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
    expect(await screen.findByRole("link", { name: /Campaign drama/ })).toBeVisible();
    expect(runtime.bootstrap).toHaveBeenCalledTimes(2);
  } finally {
    logging.mockRestore();
  }
});

it.each(["campaignCode", "campaign_code", "campaign"].flatMap(key => [true, false].map(cached => ({ key, cached }))))("仅携带 $key 的投放入口跳过首页且不拉目录，封面缓存=$cached，主动返回后仍可浏览首页", async ({ key, cached }) => {
  window.history.replaceState({}, "", `/?${key}=campaign-1`);
  const runtime = runtimeFor();
  let target: ReturnType<Runtime["getLaunchTarget"]>;
  let finish!: () => void;
  runtime.getLaunchTarget = () => target;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => {
    finish = () => {
      target = { dramaId: drama.id, episodeId: drama.episodes[0].id };
      resolve();
    };
  }));
  runtime.loadReviewHome = vi.fn(async () => ({ tiktokAppId: "test-app", enabled: false, revision: 0, dramas: [] }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  runtime.getCachedPublicCatalog = () => cached ? { dramas: [{ ...drama, coverUrl: "https://images.example/campaign-cover.jpg" }] } : undefined;
  runtime.preparePlayback = vi.fn(async () => undefined);

  const view = render(<App runtime={runtime} />);
  expect(view.container).toBeEmptyDOMElement();
  expect(view.container.querySelector(".square-page")).toBeNull();
  expect(document.head.querySelector(mediaPreconnect)).toHaveAttribute("crossorigin", "anonymous");
  expect(runtime.preparePlayback).toHaveBeenCalledOnce();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  expect(runtime.loadReviewHome).not.toHaveBeenCalled();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();

  await act(async () => finish());
  await waitFor(() => expect(window.location.hash).toBe("#/watch/campaign-drama/campaign-episode"));
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
  expect(document.head.querySelectorAll(mediaPreconnect)).toHaveLength(1);
  expect(runtime.loadReviewHome).not.toHaveBeenCalled();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: text("common.back") }));
  expect(await screen.findByRole("heading", { name: "More Drama" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/");
  expect(runtime.loadReviewHome).toHaveBeenCalledOnce();
  expect(runtime.api.resolvePlay).toHaveBeenCalledOnce();
});

it("投放启动失败在播放加载态重试，保留错误日志并按服务端目标进入剧场", async () => {
  window.history.replaceState({}, "", "/?campaignCode=campaign-1");
  const runtime = runtimeFor();
  let target: ReturnType<Runtime["getLaunchTarget"]>;
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  runtime.getLaunchTarget = () => target;
  runtime.bootstrap = vi.fn()
    .mockRejectedValueOnce(new ApiError("Launch lookup failed token=private-value", 503, "service_unavailable"))
    .mockImplementationOnce(async () => {
      target = { dramaId: drama.id, episodeId: drama.episodes[0].id };
    });
  runtime.loadReviewHome = vi.fn(async () => ({ tiktokAppId: "test-app", enabled: false, revision: 0, dramas: [] }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  runtime.getCachedPublicCatalog = () => ({ dramas: [{ ...drama, coverUrl: "https://images.example/campaign-cover.jpg" }] });

  render(<App runtime={runtime} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(text("apiErrors.serviceUnavailable"));
  expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "app_initialize_failed", error: "Launch lookup failed token=[REDACTED]" }));
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  expect(runtime.loadReviewHome).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
  expect(window.location.hash).toBe("#/watch/campaign-drama/campaign-episode");
  expect(runtime.bootstrap).toHaveBeenCalledTimes(2);
  expect(runtime.loadReviewHome).not.toHaveBeenCalled();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
  logging.mockRestore();
});

it("投放目标确认无效后才展示首页，保留已有的无目标落地行为", async () => {
  window.history.replaceState({}, "", "/?campaignCode=unavailable-campaign&coverDramaId=663&coverEpisodeId=18426&coverKey=covers%2Fmain.jpg&coverTitle=Early+preview&coverEpisodeNumber=1&coverEpisodeCount=20");
  const runtime = runtimeFor();
  let finish!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));

  const view = render(<App runtime={runtime} />);
  expect(view.container.querySelector(".playback-launch-preview img")).toHaveAttribute("src", "https://img.tkdrama.site/covers/main.jpg");
  expect(screen.getByText("Early preview")).toBeInTheDocument();
  expect(screen.getByText("Episode 1 of 20")).toBeInTheDocument();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(await screen.findByRole("link", { name: /Campaign drama/ })).toBeInTheDocument();
  expect(screen.queryByText("Early preview")).not.toBeInTheDocument();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
});

it("播放深链登录未完成时直接展示公开封面，跳过品牌中间页", async () => {
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  const runtime = runtimeFor();
  const preview = { ...drama, coverUrl: "https://images.example/cover~tplv-vod-noop.image" };
  runtime.getCachedPublicCatalog = () => ({ dramas: [preview] });
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [preview] }));
  runtime.bootstrap = vi.fn(() => new Promise<void>(() => undefined));

  const view = render(<App runtime={runtime} />);
  expect(view.container.querySelector(".playback-launch-preview img")).toHaveAttribute("src", "https://images.example/cover~tplv-vod-rs:480:0.webp");
  expect(view.container.querySelector(".playback-launch-preview .startup-screen")).toBeNull();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
});

it("播放身份就绪后的预览使用本地历史分集海报", async () => {
  window.location.hash = "#/watch/campaign-drama/episode-2";
  const runtime = runtimeFor();
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  runtime.getCachedPublicCatalog = () => ({ dramas: [{ ...drama, coverUrl: "https://images.example/drama-cover.jpg" }] });
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [{ ...drama, coverUrl: "https://images.example/drama-cover.jpg" }] }));
  runtime.localLibrary.history = vi.fn(() => [{
    dramaId: "campaign-drama", episodeId: "episode-2", episodeNumber: 2,
    progressSeconds: 60, durationSeconds: 120, posterUrl: "https://images.example/history-episode.jpg",
    updatedAt: "2026-09-23T00:00:00.000Z",
  }]);
  runtime.api.drama = vi.fn((_dramaId: string) => new Promise<DramaDetail>(() => undefined));
  runtime.api.resolvePlay = vi.fn((_dramaId: string, _episodeId: string) => new Promise<PlayResolveResult>(() => undefined));

  const view = render(<App runtime={runtime} />);
  await waitFor(() => expect(view.container.querySelector(".playback-launch-preview img")).toHaveAttribute("src", expect.stringContaining("drama-cover")));
  await act(async () => complete());
  await waitFor(() => {
    const preview = view.container.querySelector(".playback-launch-preview img, .player-transition-poster");
    expect(preview).toHaveAttribute("src", expect.stringContaining("history-episode"));
  });
});

it("首次深链没有封面缓存时不扫描目录，身份就绪后只读取目标剧目和播放决策", async () => {
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  const runtime = runtimeFor();
  const preview = { ...drama, coverUrl: "https://images.example/first-visit.jpg" };
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [preview] }));
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  runtime.api.drama = vi.fn(async () => preview);

  const view = render(<App runtime={runtime} />);
  expect(view.container).toBeEmptyDOMElement();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
  expect(runtime.api.drama).not.toHaveBeenCalled();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  await act(async () => complete());
  await waitFor(() => expect(runtime.api.resolvePlay).toHaveBeenCalled());
  expect(runtime.api.drama).toHaveBeenCalledWith(drama.id);
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
});

it.each((["tiktok_minis", "byteplus_web"] as const).flatMap(provider =>
  (["launch", "selection"] as const).flatMap(source => [false, true].flatMap(required =>
    (source === "launch" ? [false, true] : [false]).map(early => ({ provider, source, required, early }))))))(
  "$provider 的 $source 入口提前完成=$early 时只使用一次起播决策并保留强制 VIP=$required",
  async ({ provider, source, required, early }) => {
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  const watchPath = `#/watch/${drama.id}/${drama.firstEpisodeId}`;
  window.history.replaceState({}, "", source === "launch" ? "/?campaignCode=campaign-1" : `/${watchPath}`);
  window.TTMinis = createTikTokFixture().sdk;
  let finishEntry!: (response: Response) => void;
  const entry = new Promise<Response>(resolve => { finishEntry = resolve; });
  const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data, serverTime: new Date().toISOString() }));
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split("?")[0];
    if (path.endsWith("/open/app-config")) return response({ applicationId: "1", tiktokAppId: "test-app", appName: "Test", logoUrl: "", complianceBaseUrl: "", playbackSdk: { provider, channel: "byteplus", ...(provider === "byteplus_web" ? { capabilities: { mediaPreload: false } } : {}) }, monetization: { ...inactiveExperience.monetizationPolicy, status: "enabled", vip: { enabled: true, requireBeforePlayback: required, requiredAdCount: 2, title: "", content: "" } } });
    if (path.endsWith("/session")) return response({ applicationId: "1", tiktokAppId: "test-app", visitorId: "11", visitorToken: "test-session-token", identityState: "tiktok_authenticated", ...(source === "launch" ? { campaign: { id: "campaign-1", code: "campaign-1", dramaId: drama.id, episodeId: drama.firstEpisodeId } } : {}) });
    if (path.endsWith("/play/entry")) return entry;
    if (path.endsWith("/me/vip")) return response(inactiveExperience.vipState);
    if (path.endsWith("/me/vip/offer")) return response({ offer: null });
    if (path.endsWith(`/dramas/${drama.id}`)) return response(drama);
    if (path.endsWith("/metrics")) return response({ accepted: true });
    throw new Error(`unexpected route ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const { DirectVePlayerAdapter } = await import("./player/vePlayerEngine");
  const direct = vi.spyOn(DirectVePlayerAdapter.prototype, "getConstructor").mockResolvedValue(class {} as never);
  const official = vi.fn(async () => class {} as never);
  const runtime = createRuntime({ getConstructor: official });
  const mount = vi.fn<PlaybackEngine["mount"]>(async () => true);
  runtime.createPlaybackEngine = () => ({
    mount, switchSource: vi.fn(async () => {}), play: vi.fn(async () => {}),
    pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
    snapshot: () => ({ currentTime: 0, duration: 60, paused: true, ended: false }),
  });
  try {
    const startup = early ? startApplication(runtime, true) : undefined;
    if (!early) render(<App runtime={runtime} />);
    const paths = () => fetcher.mock.calls.map(([url]) => String(url).split("?")[0]);
    const duplicate = /me\/entry-ad|play\/resolve|launch\/resolve|open\/(catalog|home|review-home)/;
    await waitFor(() => expect(paths().filter(path => path.endsWith("/play/entry"))).toHaveLength(1));
    expect(paths().some(path => duplicate.test(path))).toBe(false);
    expect(paths().some(path => path.endsWith(`/dramas/${drama.id}`))).toBe(false);
    const request = fetcher.mock.calls.find(([url]) => String(url).endsWith("/play/entry"))?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ source });
    const playback = {
      channel: "byteplus", vid: "test-entry-vid", title: "Episode 1", posterUrl: "", episodeNumber: 1, durationSeconds: 60,
      ...(provider === "byteplus_web" ? { playAuthToken: "test-entry-token", expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { albumId: "album-1", episodeId: "platform-episode-1" }),
    };
    const play = { status: "playable", drama, episode: drama.episodes[0], playback };
    await act(async () => finishEntry(response({ entry: {
      target: { dramaId: drama.id, episodeId: drama.firstEpisodeId },
      drama, episode: drama.episodes[0],
      entryAdStatus: { enabled: false, completedCount: 0, requiredCount: 0 },
      vipState: inactiveExperience.vipState, ...(required ? {} : { play }),
    } })));
    if (startup) {
      await startup.bootstrap;
      render(<App runtime={runtime} startup={startup} />);
    }
    await waitFor(() => expect(window.location.hash).toBe(watchPath));
    if (!required) {
      await waitFor(() => expect(mount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider, vid: playback.vid }), expect.anything()));
      expect(paths().filter(path => path.endsWith(`/dramas/${drama.id}`))).toHaveLength(1);
    } else {
      expect(mount).not.toHaveBeenCalled();
      expect(paths().some(path => path.endsWith(`/dramas/${drama.id}`))).toBe(false);
    }
    expect(paths().filter(path => path.endsWith("/play/entry"))).toHaveLength(1);
    expect(paths().some(path => duplicate.test(path))).toBe(false);
    if (source === "launch") expect(paths().some(path => path.endsWith("/me/vip"))).toBe(false);
    expect(provider === "tiktok_minis" ? direct : official).not.toHaveBeenCalled();
  } finally {
    direct.mockRestore();
  }
});

/** recoverableRuntime 模拟运行中的身份安装失败，不把普通接口故障当作登录事件。 */
function recoverableRuntime() {
  const runtime = runtimeFor();
  let state: RuntimeSessionState = "ready";
  const listeners = new Set<() => void>();
  const publish = (next: RuntimeSessionState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  runtime.getSessionState = () => state;
  runtime.subscribeSessionState = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  runtime.recoverSession = vi.fn(async () => { publish("ready"); });
  return { runtime, publish };
}

it("运行中身份封闭显示可访问重试入口，仅用户点击后恢复并保留当前路由", async () => {
  const { runtime, publish } = recoverableRuntime();
  const { container } = render(<App runtime={runtime} />);
  await screen.findByText("Campaign drama");
  const originalRoute = window.location.hash;
  act(() => publish("recovery_required"));
  expect(screen.getByRole("alert")).toHaveTextContent(text("apiErrors.sessionUnavailable"));
  expect(runtime.recoverSession).not.toHaveBeenCalled();
  expect(runtime.bootstrap).toHaveBeenCalledOnce();

  let completeRecovery!: () => void;
  vi.mocked(runtime.recoverSession!).mockImplementationOnce(() => new Promise<void>((resolve) => {
    completeRecovery = () => { publish("ready"); resolve(); };
  }));
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole("button", { name: text("common.retry") })).not.toBeInTheDocument();
  await act(async () => completeRecovery());
  await screen.findByText("Campaign drama");
  expect(runtime.recoverSession).toHaveBeenCalledOnce();
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
  expect(window.location.hash).toBe(originalRoute);
});

it("恢复失败保留友好提示和重试入口，不显示底层异常且不自动循环", async () => {
  const { runtime, publish } = recoverableRuntime();
  render(<App runtime={runtime} />);
  await screen.findByText("Campaign drama");
  act(() => publish("recovery_required"));
  vi.mocked(runtime.recoverSession!).mockRejectedValueOnce(new Error("private observer stack"));
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(text("app.initializeError"));
  expect(screen.queryByText("private observer stack")).not.toBeInTheDocument();
  expect(runtime.recoverSession).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: text("common.retry") }));
  await screen.findByText("Campaign drama");
  expect(runtime.recoverSession).toHaveBeenCalledTimes(2);
});

it("切换运行时后忽略旧启动的迟到失败", async () => {
  const previous = runtimeFor();
  let failPrevious!: (reason: Error) => void;
  vi.mocked(previous.bootstrap).mockImplementation(() => new Promise<void>((_resolve, reject) => {
    failPrevious = reject;
  }));
  const { rerender } = render(<App runtime={previous} />);
  const current = runtimeFor();
  rerender(<App runtime={current} />);
  await screen.findByText("Campaign drama");
  await act(async () => failPrevious(new Error("obsolete startup")));
  expect(screen.getByText("Campaign drama")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([true])("真实 App 换主体同时修改语言=%s，只在完整安装后以新身份重新验权，退出进度仍归原主体", async (changeLanguage) => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  window.TTMinis = createTikTokFixture().sdk;
  new LocalLibraryStore("test-app", "A", storage).setFollow(drama.id, true);
  let visitor = "A";
  let bootstrapCount = 0;
  const resolveTokens: string[] = [];
  const startup = () => ({
      applicationId: "application", tiktokAppId: "test-app", visitorId: visitor, visitorToken: `token-${visitor}`,
      appName: "Drama", logoUrl: "", complianceBaseUrl: "", identityState: "tiktok_authenticated",
      playbackSdk: { provider: "tiktok_minis", channel: "byteplus" },
      vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "today" },
      monetization: { status: "disabled", strategy: "episode_reward", freeEpisodeCount: 5,
        episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
        vip: { enabled: false, requiredAdCount: 1, title: "", content: "" } },
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith("session")) {
      bootstrapCount += 1;
      return new Response(JSON.stringify({ data: startup() }));
    }
    if (path.includes("/open/app-config")) return new Response(JSON.stringify({ data: startup() }));
    if (path.endsWith("/me/vip")) return new Response(JSON.stringify({ data: startup().vipState }));
    if (path.endsWith("/play/entry") || path.split("?", 1)[0]?.endsWith("/play/resolve")) {
      resolveTokens.push(new Headers(init?.headers).get("authorization") || "");
      const play = {
        status: "playable", drama, episode: drama.episodes[0],
        playback: { channel: "byteplus", albumId: "album", episodeId: "official-1", vid: "vid-1",
          title: "Episode 1", posterUrl: "", episodeNumber: 1, durationSeconds: 60 },
      };
      const entry = {
        target: { dramaId: drama.id, episodeId: drama.firstEpisodeId }, drama, episode: drama.episodes[0], play,
        entryAdStatus: { enabled: false, completedCount: 0, requiredCount: 0 }, vipState: startup().vipState,
      };
      return new Response(JSON.stringify({ data: path.endsWith("/play/entry") ? { entry } : play }));
    }
    if (path.split("?")[0].endsWith("me/entry-ad")) {
      return new Response(JSON.stringify({ data: { enabled: false, completedCount: 0, requiredCount: 0 } }));
    }
    return new Response(JSON.stringify({ data: drama }));
  }));
  const engines: PlaybackEngine[] = [];
  const callbacks: PlaybackCallbacks[] = [];
  const runtime = createRuntime();
  // 此处仅验证身份切换与页面重挂，播放器生命周期由下方测试引擎观测。
  runtime.preparePlayback = vi.fn(async () => undefined);
  runtime.preloadMedia = vi.fn(async () => undefined);
  runtime.createPlaybackEngine = () => {
    const engine: PlaybackEngine = {
      mount: vi.fn(async (_root, _source, nextCallbacks) => { callbacks.push(nextCallbacks || {}); return true; }),
      switchSource: vi.fn(async () => undefined), play: vi.fn(async () => undefined),
      pause: vi.fn(), seek: vi.fn(), destroy: vi.fn(),
      snapshot: () => ({ currentTime: 0, duration: 60, paused: false, ended: false }),
    };
    engines.push(engine);
    return engine;
  };
  window.location.hash = "#/watch/campaign-drama/campaign-episode";
  render(<App runtime={runtime} />);
  await waitFor(() => expect(callbacks).toHaveLength(1));
  const originalLibrary = runtime.localLibrary;
  expect(originalLibrary.follows()).toEqual([
    expect.objectContaining({ dramaId: "campaign-drama" }),
  ]);
  const originalSubject = runtime.getSessionSubjectKey!();
  // 同主体刷新不重挂、不额外换码，更不会重新安装 Player。
  await act(() => runtime.refreshBootstrap());
  expect(callbacks).toHaveLength(1);
  expect(runtime.getSessionSubjectKey!()).toBe(originalSubject);
  act(() => callbacks[0].onTimeUpdate?.({ currentTime: 3, duration: 60, paused: false, ended: false }));
  visitor = "B";
  await act(() => runtime.refreshBootstrap());
  await waitFor(() => expect(callbacks).toHaveLength(2));
  expect(engines[0].destroy).toHaveBeenCalledOnce();
  expect(resolveTokens).toEqual(["Bearer token-A", "Bearer token-B"]);
  expect(bootstrapCount).toBe(3);
  expect(runtime.getSessionSubjectKey!()).not.toBe(originalSubject);
  expect(originalLibrary.history()[0].progressSeconds).toBe(3);
  expect(originalLibrary.history()[0].drama?.title).toBe(drama.title);
  expect(runtime.localLibrary).not.toBe(originalLibrary);
  expect(runtime.localLibrary.history()).toEqual([]);
  expect(runtime.localLibrary.follows()).toEqual([]);
});

it("登录前后保留分类榜选择，全部目录始终独立分页", async () => {
  vi.useFakeTimers();
  try {
    const runtime = runtimeFor();
    let complete!: () => void;
    runtime.bootstrap = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const matched = { ...drama, title: "Mystery finale", status: "completed" as const, tags: ["Mystery"] };
    runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama], tags: ["Mystery", "Romance"] }));
    runtime.loadHomeSections = vi.fn(async () => ({ carousel: [], hot: [], rankings: [
      { tagId: "23", name: "Romance", dramas: [drama] },
      { tagId: "21", name: "Mystery", dramas: [matched] },
    ] }));
    const view = render(<App runtime={runtime} />);
    await act(async () => undefined);
    const shell = view.container.querySelector("main")?.className;
    expect(screen.getByRole("navigation", { name: text("nav.primary") })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(All|Ongoing|Completed)$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mystery" }));
    await act(async () => undefined);
    expect(runtime.loadPublicCatalog).toHaveBeenLastCalledWith({ limit: 20 });
    expect(screen.getByText("Mystery finale")).toBeInTheDocument();
    expect(runtime.api.discover).not.toHaveBeenCalled();
    expect(runtime.localLibrary.follows).not.toHaveBeenCalled();
    expect(runtime.localLibrary.continueWatching).not.toHaveBeenCalled();
    await act(async () => complete());
    expect(view.container.querySelector("main")?.className).toBe(shell);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mystery" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^(All|Ongoing|Completed)$/ })).not.toBeInTheDocument();
    expect(runtime.api.discover).not.toHaveBeenCalled();
    expect(runtime.loadPublicCatalog).toHaveBeenCalledOnce();
    expect(runtime.loadHomeSections).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

it("公开目录下滑自动追加真实结果，登录重试期间保留已加载首页且不重复拉取", async () => {
  const reachBottom = observeCatalogBottom();
  const runtime = runtimeFor();
  let complete!: () => void;
  const next = { ...drama, id: "second", title: "Second title" };
  runtime.bootstrap = vi.fn().mockRejectedValueOnce(new Error("SDK timeout"))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async (input) => input?.cursor
    ? { dramas: [next], tags: ["Mystery"] }
    : { dramas: [drama], tags: ["Mystery"], nextCursor: "next-page" });
  render(<App runtime={runtime} />);
  await reachBottom();
  expect(await screen.findByText("Second title")).toBeInTheDocument();
  expect(screen.getByText("Campaign drama")).toBeInTheDocument();
  expect(runtime.loadPublicCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next-page", limit: 20 }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByText("Second title")).toBeInTheDocument();
  expect(runtime.loadPublicCatalog).toHaveBeenCalledTimes(2);
  expect(runtime.bootstrap).toHaveBeenCalledTimes(2);
  await act(async () => complete());
  expect(screen.getByText("Second title")).toBeInTheDocument();
  expect(runtime.loadPublicCatalog).toHaveBeenCalledTimes(2);
});

it("公开目录失败可独立重载，显示统一错误并记录脱敏原因，不重复登录", async () => {
  const runtime = runtimeFor();
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    runtime.bootstrap = vi.fn(() => new Promise<void>(() => undefined));
    runtime.loadPublicCatalog = vi.fn().mockRejectedValueOnce(new Error("catalog unavailable token=secret"))
      .mockResolvedValueOnce({ dramas: [drama] });
    render(<App runtime={runtime} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text("home.discoveryError"));
    expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "public_catalog_load_failed", error: "catalog unavailable token=[REDACTED]" }));
    expect(screen.getByRole("heading", { name: "More Drama" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload titles" }));
    expect(await screen.findByText("Campaign drama")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(runtime.bootstrap).toHaveBeenCalledOnce();
  } finally { logging.mockRestore(); }
});

it("历史只在登录主体确认后展示，等待期间不读取匿名或旧账号记录", async () => {
  const runtime = runtimeFor();
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  render(<App runtime={runtime} />);
  fireEvent.click(await screen.findByRole("button", { name: "My List" }));
  expect(window.location.hash).toBe("#/library");
  expect(screen.queryByRole("heading", { name: "History", level: 1 })).not.toBeInTheDocument();
  expect(runtime.localLibrary.history).not.toHaveBeenCalled();
  await act(async () => complete());
  expect(await screen.findByRole("heading", { name: "History", level: 1 })).toBeInTheDocument();
  // 当前主体没有本地历史时不再额外扫描目录；首页公开目录照常加载。
  expect(runtime.loadPublicCatalog).toHaveBeenCalledOnce();
  expect(runtime.api.home).not.toHaveBeenCalled();
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
});

it("登录前点击 Profile 保留导航，认证成功才挂载账号页面", async () => {
  const runtime = runtimeFor();
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  runtime.getComplianceBaseURL = () => "";
  runtime.localLibrary.followedDramas = vi.fn(() => []);
  render(<App runtime={runtime} />);
  fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
  expect(window.location.hash).toBe("#/profile");
  expect(screen.queryByRole("heading", { name: "Profile" })).not.toBeInTheDocument();
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
  await act(async () => complete());
  expect(await screen.findByRole("heading", { name: "Profile", level: 1 })).toBeInTheDocument();
});

it("登录前后 More Drama 都不展示收藏按钮，也不读写收藏", async () => {
  const runtime = runtimeFor();
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  render(<App runtime={runtime} />);
  await screen.findByText(drama.title);
  expect(screen.queryByRole("button", { name: /Add to My List|Saved/ })).not.toBeInTheDocument();
  await act(async () => complete());
  expect(screen.queryByRole("button", { name: /Add to My List|Saved/ })).not.toBeInTheDocument();
  expect(runtime.localLibrary.setFollow).not.toHaveBeenCalled();
  expect(runtime.localLibrary.follows).not.toHaveBeenCalled();
});

it("等待登录时返回 Home 会取消个人导航和启动深链，不自动跳走", async () => {
  const runtime = runtimeFor({ dramaId: drama.id, episodeId: drama.firstEpisodeId });
  let complete!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  render(<App runtime={runtime} />);
  fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
  fireEvent.click(screen.getByRole("button", { name: "Home" }));
  await act(async () => complete());
  expect(await screen.findByRole("heading", { name: "More Drama" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/");
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
});

it("没有分类榜时不把目录标签伪装成榜单，仍显示全部已上线目录", async () => {
  const runtime = runtimeFor();
  runtime.bootstrap = vi.fn(() => new Promise<void>(() => undefined));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [{ ...drama, tags: ["Mystery"] }], tags: ["Mystery"] }));
  runtime.loadHomeSections = vi.fn(async () => ({ carousel: [], hot: [], rankings: [] }));
  render(<App runtime={runtime} />);
  await screen.findByText("Campaign drama");
  expect(screen.queryByRole("group", { name: "Ranking categories" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Mystery" })).not.toBeInTheDocument();
  expect(runtime.loadPublicCatalog).toHaveBeenLastCalledWith({ limit: 20 });
  expect(runtime.bootstrap).toHaveBeenCalledOnce();
});

it("自动追加失败保留首屏，暂停翻页并能通过目录重试恢复", async () => {
  const reachBottom = observeCatalogBottom();
  const runtime = runtimeFor();
  runtime.bootstrap = vi.fn(() => new Promise<void>(() => undefined));
  runtime.loadPublicCatalog = vi.fn().mockResolvedValueOnce({ dramas: [drama], tags: [], nextCursor: "next" })
    .mockRejectedValueOnce(new Error("page offline token=secret"))
    .mockResolvedValueOnce({ dramas: [drama], tags: [], nextCursor: "next" })
    .mockResolvedValueOnce({ dramas: [{ ...drama, id: "second", title: "Second title" }], tags: [] });
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    render(<App runtime={runtime} />);
    await reachBottom();
    expect(await screen.findByRole("alert")).toHaveTextContent(text("home.discoveryError"));
    expect(screen.getByText("Campaign drama")).toBeInTheDocument();
    expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "home_discovery_more_failed", error: "page offline token=[REDACTED]" }));
    expect(runtime.loadPublicCatalog).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload titles" }));
    await reachBottom();
    expect(await screen.findByText("Second title")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally { logging.mockRestore(); }
});

it("登录后目录失败有脱敏诊断，恢复成功不再误报错误", async () => {
  const runtime = runtimeFor();
  vi.mocked(runtime.api.discover).mockRejectedValueOnce(new Error("discovery unavailable token=secret"));
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    render(<App runtime={runtime} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text("home.discoveryError"));
    expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "home_discovery_failed", error: "discovery unavailable token=[REDACTED]" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload titles" }));
    logging.mockClear();
    await screen.findByText(drama.title);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(logging).not.toHaveBeenCalled();
  } finally { logging.mockRestore(); }
});

it.each([false])("首页先展示轮播热播结构，登录先完成=%s 时内容不卸载或重新请求", async (loginFirst) => {
  const runtime = runtimeFor();
  let login!: () => void;
  let catalog!: (value: HomePayload) => void;
  let recommendations!: (value: HomeSections) => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { login = resolve; }));
  runtime.loadPublicCatalog = vi.fn(() => new Promise<HomePayload>(resolve => { catalog = resolve; }));
  runtime.loadHomeSections = vi.fn(() => new Promise<HomeSections>(resolve => { recommendations = resolve; }));
  const view = render(<App runtime={runtime} />);
  const main = screen.getByRole("main");
  const loading = screen.getByRole("status", { name: "Loading recommendations" });
  expect(screen.getByText("Hot Dramas")).toBeInTheDocument();
  expect(view.container.querySelector(".startup-screen")).toBeNull();
  expect(screen.queryByText(text("app.connecting"))).not.toBeInTheDocument();
  expect(view.container.querySelector("img")).toBeNull();
  if (loginFirst) {
    await act(async () => login());
    expect(screen.getByRole("status", { name: "Loading recommendations" })).toBe(loading);
  }
  await act(async () => {
    catalog({ dramas: [drama] });
    recommendations({ carousel: [drama], hot: [drama], rankings: [] });
  });
  const carousel = screen.getByRole("region", { name: "Featured dramas" });
  if (!loginFirst) await act(async () => login());
  expect(screen.getByRole("main")).toBe(main);
  expect(screen.getByRole("region", { name: "Featured dramas" })).toBe(carousel);
  expect(screen.getByRole("region", { name: "Hot Dramas" })).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Loading recommendations" })).not.toBeInTheDocument();
  expect(runtime.loadPublicCatalog).toHaveBeenCalledOnce();
  expect(runtime.loadHomeSections).toHaveBeenCalledOnce();
  expect(runtime.api.discover).not.toHaveBeenCalled();
});

it("播放器准备不等待登录，准备失败不使已登录首页失败", async () => {
  vi.useFakeTimers();
  const runtime = runtimeFor();
  let login!: () => void;
  runtime.bootstrap = vi.fn(() => new Promise<void>(resolve => { login = resolve; }));
  runtime.loadPublicCatalog = vi.fn(async () => ({ dramas: [drama] }));
  runtime.preparePlayback = vi.fn(async () => { throw new Error("preparation unavailable"); });
  render(<App runtime={runtime} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
  expect(runtime.preparePlayback).toHaveBeenCalledOnce();
  await act(async () => login());
  expect(screen.getByText("Campaign drama")).toBeInTheDocument();
  expect(screen.queryByText(text("app.unableToStart"))).not.toBeInTheDocument();
  vi.useRealTimers();
});
