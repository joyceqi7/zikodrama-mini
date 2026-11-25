import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccessOffer, AdExperience, ClaimResult } from "../domain/types";
import { ApiError } from "../api/httpMiniDramaApi";
import { RuntimeContext } from "../runtime/RuntimeContext";
import type { Runtime } from "../runtime/runtime";
import { text } from "../copy";
import { VipDialog } from "./VipDialog";
import { showRewardedAd } from "../platform/tiktok/rewardedAd";
import { hasPendingFullscreenAd, isFullscreenAdBlockingPlayback } from "../platform/tiktok/fullscreenAd";
import type { RewardedAdCloseResult, TikTokMinisSDK } from "../platform/tiktok/types";
import { adPolicy } from "../config/adPolicy";
import { getVisibilitySnapshot } from "../platform/tiktok/lifecycle";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("已有 VIP 正常重查只显示等待状态，不闪报错或重试，确认后恢复已激活权益", async () => {
  let experience: AdExperience = {
    refreshRequired: true,
    vipState: { active: true, adCount: 3, requiredCount: 3, progressDate: "2026-10-26" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 3, title: "", content: "" } },
  };
  let listener = () => {};
  const watchVIPAd = vi.fn(), claimVIP = vi.fn(), refreshAdExperience = vi.fn();
  const runtime = { getAdExperience: () => experience,
    subscribeAdExperience: (callback: () => void) => { listener = callback; return () => {}; },
    watchVIPAd, claimVIP, refreshAdExperience } as unknown as Runtime;
  render(<RuntimeContext.Provider value={runtime}><VipDialog open onClose={vi.fn()} /></RuntimeContext.Provider>);
  expect(screen.getByRole("status")).toHaveTextContent("Checking your VIP access…");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: text("common.retry") })).toBeNull();
  expect(screen.queryByText(text("apiErrors.responseUnconfirmed"))).toBeNull();
  await act(async () => { experience = { ...experience, refreshRequired: false }; listener(); });
  expect(screen.getByText(text("vip.activeToday"))).toBeInTheDocument();
  expect(watchVIPAd).not.toHaveBeenCalled();
  expect(claimVIP).not.toHaveBeenCalled();
  expect(refreshAdExperience).not.toHaveBeenCalled();
});

it("VIP 时间待确认时只显示恢复入口，服务器确认后才放行，并保留键盘焦点与触发点", async () => {
  let experience: AdExperience = {
    refreshRequired: true, refreshError: text("apiErrors.responseUnconfirmed"),
    vipState: { active: true, adCount: 2, requiredCount: 2, progressDate: "2026-10-23" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 2, title: "", content: "" } },
  };
  let listener = () => {};
  const watchVIPAd = vi.fn(), claimVIP = vi.fn(), activated = vi.fn();
  const refreshAdExperience = vi.fn(async () => { experience = { ...experience, refreshRequired: false, refreshError: undefined }; listener(); });
  const runtime = { getAdExperience: () => experience, subscribeAdExperience: (callback: () => void) => { listener = callback; return () => {}; },
    watchVIPAd, claimVIP, refreshAdExperience } as unknown as Runtime;
  const trigger = document.createElement("button");
  document.body.append(trigger); trigger.focus();
  const view = (open: boolean) => <RuntimeContext.Provider value={runtime}><VipDialog open={open} mandatory onClose={() => {}} onVIPActivated={activated} /></RuntimeContext.Provider>;
  const rendered = render(view(true));
  const dialog = screen.getByRole("dialog");
  const retry = screen.getByRole("button", { name: text("common.retry") });
  expect(document.getElementById(retry.getAttribute("aria-describedby")!)).toHaveAttribute("role", "alert");
  expect(screen.queryByText(text("vip.activeToday"))).toBeNull();
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(retry).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(screen.getByRole("button", { name: text("vip.closeOffer") })).toHaveFocus();
  fireEvent.click(retry);
  await screen.findByText(text("vip.activeToday"));
  expect(refreshAdExperience).toHaveBeenCalledOnce();
  expect(activated).toHaveBeenCalledOnce();
  expect(watchVIPAd).not.toHaveBeenCalled(); expect(claimVIP).not.toHaveBeenCalled();
  rendered.rerender(view(false));
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it("VIP 入口需手动开始，完整广告连续播放，达标后需再点击领取", async () => {
  let experience: AdExperience = {
    vipState: { active: false, adCount: 0, requiredCount: 2, progressDate: "2026-09-23" },
    monetizationPolicy: {
      status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 2, title: "", content: "" },
    },
  };
  let listener: () => void = () => {};
  const claim = (count: number): ClaimResult => ({
    claimId: `claim-${count}`, status: "granted", unlocked: false,
    dramaId: "", episodeId: "", rewardType: "vip_progress",
    vipState: { ...experience.vipState, adCount: count, active: false },
  });
  const watchVIPAd = vi.fn().mockResolvedValueOnce(claim(1)).mockResolvedValueOnce(claim(2));
  const claimVIP = vi.fn(async () => {
    experience = { ...experience, vipState: { ...experience.vipState, adCount: 2, active: true } };
    listener();
    return experience.vipState;
  });
  const runtime = {
    getAdExperience: () => experience,
    subscribeAdExperience: (callback: () => void) => { listener = callback; return () => { listener = () => {}; }; },
    watchVIPAd, claimVIP,
  } as unknown as Runtime;
  const activated = vi.fn();
  const close = vi.fn();
  render(<RuntimeContext.Provider value={runtime}><VipDialog open onClose={close} onVIPActivated={activated} /></RuntimeContext.Provider>);
  expect(watchVIPAd).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await waitFor(() => expect(watchVIPAd).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: text("vip.claimPass") });
  expect(claimVIP).not.toHaveBeenCalled();
  expect(activated).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("vip.claimPass") }));
  await waitFor(() => expect(claimVIP).toHaveBeenCalledOnce());
  await screen.findByText(text("vip.activeToday"));
  expect(activated).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: text("vip.closeOffer") }));
  expect(close).toHaveBeenCalledOnce();
});

it("强制入剧模式首次自动拉起，取消后自动接续且不授予进度", async () => {
  vi.useFakeTimers();
  const experience: AdExperience = {
    vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "2026-10-08" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requireBeforePlayback: true, requiredAdCount: 1, title: "", content: "" } },
  };
  const watchVIPAd = vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise(() => {}));
  const runtime = {
    getAdExperience: () => experience,
    subscribeAdExperience: () => () => {},
    watchVIPAd,
  } as unknown as Runtime;
  render(<RuntimeContext.Provider value={runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(watchVIPAd).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(watchVIPAd).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(text("gate.earlyClosed"))).toBeNull();
});

/** countdownRuntime 提供真实弹窗订阅和可控广告返回，不模拟服务端权益生效。 */
function countdownRuntime(seconds = 2, requiredCount = 2) {
  let experience: AdExperience = {
    vipState: { active: false, adCount: 0, requiredCount, progressDate: "2026-10-09" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requireBeforePlayback: true, entryAdCountdownSeconds: seconds, requiredAdCount: requiredCount, title: "", content: "" } },
  };
  let listener = () => {};
  const finish: Array<(claim: ClaimResult | null) => void> = [];
  const watchVIPAd = vi.fn(() => new Promise<ClaimResult | null>(resolve => finish.push(resolve)));
  const claimVIP = vi.fn(async () => {
    experience = { ...experience, vipState: { ...experience.vipState, active: true, adCount: requiredCount } };
    listener();
    return experience.vipState;
  });
  const runtime = {
    getAdExperience: () => experience,
    subscribeAdExperience: (callback: () => void) => { listener = callback; return () => { listener = () => {}; }; },
    watchVIPAd, claimVIP,
  } as unknown as Runtime;
  const completed = (adCount: number): ClaimResult => ({
    claimId: `claim-${adCount}`, status: "granted", unlocked: false, dramaId: "", episodeId: "", rewardType: "vip_progress",
    vipState: { ...experience.vipState, adCount },
  });
  /** confirmProgress 模拟服务端确认迟到完播后的权威进度通知。 */
  const confirmProgress = (adCount: number) => {
    experience = { ...experience, vipState: { ...experience.vipState, adCount } };
    listener();
  };
  return { runtime, watchVIPAd, claimVIP, finish, completed, confirmProgress };
}

/** tickSeconds 逐秒刷新 React 状态，模拟连续前台等待。 */
async function tickSeconds(seconds: number) {
  for (let i = 0; i < seconds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

it("强弹倒计时后拉起，取消后重新倒计时，完播后按服务端进度接续", async () => {
  vi.useFakeTimers();
  const fixture = countdownRuntime();
  const activated = vi.fn();
  render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} onVIPActivated={activated} /></RuntimeContext.Provider>);
  expect(screen.getByText(text("vip.adCountdown", { seconds: 2 }))).toBeInTheDocument();
  await tickSeconds(1);
  expect(fixture.watchVIPAd).not.toHaveBeenCalled();
  await tickSeconds(1);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  await act(async () => { fixture.finish[0](null); });
  expect(screen.getByText(text("vip.adCountdown", { seconds: 2 }))).toBeInTheDocument();
  await tickSeconds(1);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  await tickSeconds(1);
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
  await act(async () => { fixture.finish[1](fixture.completed(1)); });
  expect(screen.getByText(text("vip.adCountdown", { seconds: 2 }))).toBeInTheDocument();
  await tickSeconds(2);
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(3);
  await act(async () => { fixture.finish[2](fixture.completed(2)); });
  await tickSeconds(5);
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(3);
  expect(fixture.claimVIP).not.toHaveBeenCalled();
  expect(activated).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: text("vip.claimPass") }));
  await act(async () => {});
  expect(fixture.claimVIP).toHaveBeenCalledOnce();
  expect(activated).toHaveBeenCalledOnce();
});

it("后台暂停并保留剩余秒数，关闭弹窗或离页取消自动拉起", async () => {
  vi.useFakeTimers();
  const fixture = countdownRuntime(3);
  const props = { open: true, mandatory: true, onClose: vi.fn() };
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} /></RuntimeContext.Provider>);
  await tickSeconds(1);
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} visible={false} /></RuntimeContext.Provider>);
  await tickSeconds(10);
  expect(screen.getByText(text("vip.adCountdown", { seconds: 2 }))).toBeInTheDocument();
  expect(fixture.watchVIPAd).not.toHaveBeenCalled();
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} visible /></RuntimeContext.Provider>);
  await tickSeconds(1);
  expect(fixture.watchVIPAd).not.toHaveBeenCalled();
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} open={false} /></RuntimeContext.Provider>);
  await tickSeconds(5);
  expect(fixture.watchVIPAd).not.toHaveBeenCalled();
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} /></RuntimeContext.Provider>);
  expect(screen.getByText(text("vip.adCountdown", { seconds: 3 }))).toBeInTheDocument();
  view.unmount();
  await tickSeconds(5);
  expect(fixture.watchVIPAd).not.toHaveBeenCalled();
});

it("强弹广告在后台取消后暂停续拉，回前台重新倒计时且次数不变", async () => {
  vi.useFakeTimers();
  const fixture = countdownRuntime(2);
  const props = { open: true, mandatory: true, onClose: vi.fn() };
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} /></RuntimeContext.Provider>);
  await tickSeconds(2);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} visible={false} /></RuntimeContext.Provider>);
  await act(async () => fixture.finish[0](null));
  await tickSeconds(10);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  expect(screen.getByText(text("vip.adCountdown", { seconds: 2 }))).toBeInTheDocument();
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog {...props} visible /></RuntimeContext.Provider>);
  await tickSeconds(2);
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
  expect(fixture.runtime.getAdExperience().vipState.adCount).toBe(0);
  expect(fixture.claimVIP).not.toHaveBeenCalled();
});

it("首页自愿 VIP 取消后等待点击，不沿用强弹的自动续拉", async () => {
  vi.useFakeTimers();
  const fixture = countdownRuntime(2);
  render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open onClose={vi.fn()} /></RuntimeContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await act(async () => fixture.finish[0](null));
  await tickSeconds(10);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent(text("gate.earlyClosed"));
  expect(fixture.claimVIP).not.toHaveBeenCalled();
});

it("倒计时支持提前手动开始，多次点击和到零不会重复拉起", async () => {
  vi.useFakeTimers();
  const fixture = countdownRuntime();
  render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  const button = screen.getByRole("button", { name: text("vip.watchAd") });
  fireEvent.click(button);
  fireEvent.click(button);
  await tickSeconds(5);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  expect(fixture.watchVIPAd).toHaveBeenCalledWith(undefined, expect.objectContaining({ userInitiated: true }));
});

it("配置零秒仍立即拉起，普通首页 VIP 忽略入剧倒计时", async () => {
  vi.useFakeTimers();
  const immediate = countdownRuntime(0);
  const view = render(<RuntimeContext.Provider value={immediate.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(immediate.watchVIPAd).toHaveBeenCalledOnce();
  view.unmount();
  const voluntary = countdownRuntime(2);
  render(<RuntimeContext.Provider value={voluntary.runtime}><VipDialog open onClose={vi.fn()} /></RuntimeContext.Provider>);
  await tickSeconds(5);
  expect(voluntary.watchVIPAd).not.toHaveBeenCalled();
  expect(screen.queryByText(text("vip.adCountdown", { seconds: 2 }))).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  expect(voluntary.watchVIPAd).toHaveBeenCalledOnce();
});

it("倒计时拉起失败后停止循环并记录脱敏错误，用户可再次开始", async () => {
  vi.useFakeTimers();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = countdownRuntime();
  fixture.watchVIPAd.mockRejectedValueOnce(new Error("ad load failed token=private-value https://ads.example/private"));
  render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  await tickSeconds(2);
  expect(screen.getByRole("alert")).toHaveTextContent(text("vip.grantError"));
  expect(errorLog).toHaveBeenCalledOnce();
  expect(errorLog).toHaveBeenCalledWith({ event: "vip_rewarded_ad_failed", error: "ad load failed token=[REDACTED] [URL]" });
  await tickSeconds(5);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
  expect(errorLog).toHaveBeenCalledOnce();
});

it("倒计时和手动重试均按广告故障提示，保留脱敏原因，不继续自动拉起", async () => {
  vi.useFakeTimers();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = countdownRuntime();
  fixture.watchVIPAd.mockRejectedValue(new ApiError("ad inventory unavailable token=private-value", 503, "rewarded_ad_unavailable"));
  render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  await tickSeconds(2);
  expect(screen.getByRole("alert")).toHaveTextContent(text("runtime.rewardedAdFailed"));
  expect(screen.queryByText(text("vip.grantError"))).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent(text("runtime.rewardedAdFailed"));
  await tickSeconds(5);
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
  expect(errorLog).toHaveBeenCalledTimes(2);
  expect(errorLog).toHaveBeenLastCalledWith({ event: "vip_rewarded_ad_failed", error: "ad inventory unavailable token=[REDACTED]" });
});

it("VIP原生结果未知使用固定等待提示并停止自动重拉，不误报用户取消", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = countdownRuntime(0);
  fixture.watchVIPAd.mockRejectedValue(new ApiError("Native ad result is still pending", 503, "rewarded_ad_pending"));
  render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  await tickSeconds(1);
  expect(screen.getByRole("alert")).toHaveTextContent(text("runtime.rewardedAdPending"));
  await tickSeconds(30);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "vip_rewarded_ad_failed" }));
  await act(async () => { fixture.confirmProgress(1); });
  expect(screen.queryByText(text("runtime.rewardedAdPending"))).toBeNull();
  await tickSeconds(5);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
});

it("50008 停止强弹自动衔接，用户点击恢复带手动意图且关闭后意图失效", async () => {
  vi.useFakeTimers();
  const fixture = countdownRuntime(0, 1);
  fixture.watchVIPAd.mockRejectedValueOnce(new ApiError("container unavailable", 503, "ad_foreground_required"));
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  await tickSeconds(10);
  expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await act(async () => {});
  expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
  const calls = fixture.watchVIPAd.mock.calls as unknown as [unknown, import("../platform/tiktok/adIntent").AdIntent][];
  expect(calls[0][1].userInitiated).toBe(false);
  expect(calls[1][1].userInitiated).toBe(true);
  expect(calls[1][1].isCurrent()).toBe(true);
  view.rerender(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open={false} mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  expect(calls[1][1].isCurrent()).toBe(false);
});

it.each([true, false])("VIP Offer 后台往返后仅恢复前台类错误，不自动重试普通故障：recoverable=%s", async recoverable => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  let reject!: (error: Error) => void;
  const experience = {
    vipState: { active: false, adCount: 0, requiredCount: 2, progressDate: "2026-11-03" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 2, entryAdCountdownSeconds: 0, title: "", content: "" } },
  } as AdExperience;
  const watchVIPAd = vi.fn<Runtime["watchVIPAd"]>().mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const runtime = { getAdExperience: () => experience, subscribeAdExperience: () => () => {}, watchVIPAd } as unknown as Runtime;
  const view = render(<RuntimeContext.Provider value={runtime}><VipDialog open mandatory onClose={() => {}} /></RuntimeContext.Provider>);
  try {
    await waitFor(() => expect(watchVIPAd).toHaveBeenCalledOnce());
    fireEvent(window, new Event("pagehide")); fireEvent(window, new Event("pageshow"));
    await act(async () => reject(new ApiError("Ad operation failed token=private", 503, recoverable ? "ad_foreground_required" : "rewarded_ad_unavailable")));
    if (recoverable) {
      await waitFor(() => expect(watchVIPAd).toHaveBeenCalledTimes(2));
      expect(watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(false);
      expect(watchVIPAd.mock.calls[1][1]?.isCurrent()).toBe(true);
      expect(warns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "vip_rewarded_ad_failed", error: "Ad operation failed token=[REDACTED]" }));
      // 新周期又明确失败时必须等待下一次前台或手动操作，不能在同一周期无限自动重试。
      await act(async () => reject(new ApiError("Container is still unavailable", 503, "ad_foreground_required")));
      await screen.findByText(text("runtime.rewardedAdFailed"));
      expect(watchVIPAd).toHaveBeenCalledTimes(2);
      expect(errors).not.toHaveBeenCalled();
    } else {
      await screen.findByText(text("runtime.rewardedAdFailed"));
      expect(watchVIPAd).toHaveBeenCalledOnce();
      expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "vip_rewarded_ad_failed", error: "Ad operation failed token=[REDACTED]" }));
    }
    expect(JSON.stringify([...errors.mock.calls, ...warns.mock.calls])).not.toContain("private");
  } finally { view.unmount(); }
});

/** nativeVIPRuntime 使用真实广告适配器和可控原生回调，复现失败返回早于原生关闭的独立时序。 */
function nativeVIPRuntime(countdownSeconds: number) {
  let shownCount = 0;
  const ads: Array<{ close(): void; error(reason: unknown): void }> = [];
  const create = vi.fn(() => {
    let close!: (result: RewardedAdCloseResult) => void;
    let error!: (reason: unknown) => void;
    ads.push({ close: () => close({ isEnded: false }), error: reason => error(reason) });
    return { show: () => Promise.resolve(), onClose: (listener: typeof close) => { close = listener; },
      onError: (listener: typeof error) => { error = listener; }, offClose: vi.fn(), offError: vi.fn() };
  });
  const sdk = { canIUse: () => true, createRewardedVideoAd: create } as unknown as TikTokMinisSDK;
  let experience = {
    vipState: { active: false, adCount: 0, requiredCount: 2, progressDate: "2026-11-03" },
    monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 0,
      episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
      vip: { enabled: true, requiredAdCount: 2, entryAdCountdownSeconds: countdownSeconds, title: "", content: "" } },
  } as AdExperience;
  const watchVIPAd = vi.fn<Runtime["watchVIPAd"]>(async (_offer, intent) => {
    const result = await showRewardedAd(sdk, "slot", () => { shownCount++; }, undefined, undefined, intent);
    if (result.status === "failed") throw new ApiError("Ad foreground required", 503, "ad_foreground_required");
    if (result.status === "unknown") throw new ApiError("Native ad result is pending", 503, "rewarded_ad_pending");
    return null;
  });
  let listener = () => {};
  const runtime = { getAdExperience: () => experience,
    subscribeAdExperience: (next: () => void) => { listener = next; return () => { listener = () => {}; }; },
    watchVIPAd, isFullscreenAdActive: () => isFullscreenAdBlockingPlayback(sdk) } as unknown as Runtime;
  return { runtime, sdk, ads, create, watchVIPAd, shownCount: () => shownCount,
    updateExperience: (change: Partial<AdExperience>) => { experience = { ...experience, ...change }; listener(); } };
}

it.each([
  { closeBeforeForeground: true, countdownSeconds: 0 }, { closeBeforeForeground: false, countdownSeconds: 0 },
  { closeBeforeForeground: true, countdownSeconds: 1 }, { closeBeforeForeground: false, countdownSeconds: 1 },
])("VIP 50008 恢复等待真实原生关闭，只创建一条新广告：关闭先于前台=$closeBeforeForeground，倒计时=$countdownSeconds", async ({ closeBeforeForeground, countdownSeconds }) => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(countdownSeconds);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    await tickSeconds(2);
    expect(fixture.shownCount()).toBe(1);
    await act(async () => {
      fireEvent(window, new Event("pagehide"));
      fixture.ads[0].error({ errorCode: "101150000", subErrorCode: "50008", errMsg: "container unavailable token=private" });
      if (closeBeforeForeground) fixture.ads[0].close();
      fireEvent(window, new Event("pageshow"));
    });
    if (!closeBeforeForeground) {
      await tickSeconds(3);
      expect(hasPendingFullscreenAd(fixture.sdk)).toBe(true);
      expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
      expect(fixture.create).toHaveBeenCalledOnce();
      expect(screen.queryByText(text("runtime.rewardedAdPending"))).toBeNull();
      await act(async () => fixture.ads[0].close());
    }
    await tickSeconds(3);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    expect(fixture.shownCount()).toBe(2);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(false);
    expect(screen.queryByText(text("runtime.rewardedAdPending"))).toBeNull();
    expect(fixture.runtime.getAdExperience().vipState.adCount).toBe(0);
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", error: "container unavailable token=[REDACTED]" }));
    expect(warns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "vip_rewarded_ad_failed" }));
    expect(JSON.stringify([...errors.mock.calls, ...warns.mock.calls])).not.toContain("private");
  } finally {
    view.unmount();
    await act(async () => fixture.ads.forEach(ad => ad.close()));
  }
});

it.each(["close", "unmount"] as const)("VIP 等待原生关闭时 %s 取消自动恢复，旧关闭回调不再启动广告", async stop => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const content = (open: boolean) => <RuntimeContext.Provider value={fixture.runtime}><VipDialog open={open} mandatory onClose={vi.fn()} /></RuntimeContext.Provider>;
  const view = render(content(true));
  try {
    await tickSeconds(2);
    await act(async () => {
      fireEvent(window, new Event("pagehide"));
      fixture.ads[0].error({ errorCode: "101150000", subErrorCode: "50008" });
      fireEvent(window, new Event("pageshow"));
    });
    if (stop === "close") view.rerender(content(false)); else view.unmount();
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it("VIP 等待原生关闭时后台取消检查，回前台后才按当前状态继续", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const content = (visible: boolean) => <RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory visible={visible} onClose={vi.fn()} /></RuntimeContext.Provider>;
  const view = render(content(true));
  try {
    await tickSeconds(2);
    await act(async () => {
      fireEvent(window, new Event("pagehide"));
      fixture.ads[0].error({ errorCode: "101150000", subErrorCode: "50008" });
      fireEvent(window, new Event("pageshow"));
    });
    view.rerender(content(false));
    fireEvent(window, new Event("pagehide"));
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(content(true));
    fireEvent(window, new Event("pageshow"));
    await tickSeconds(2);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    expect(fixture.create).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it("VIP 等待原生关闭超时后仍按未知结果停止，不释放原生互斥或自动重拉", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    await tickSeconds(2);
    await act(async () => {
      fireEvent(window, new Event("pagehide"));
      fixture.ads[0].error({ errorCode: "101150000", subErrorCode: "50008" });
      fireEvent(window, new Event("pageshow"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(adPolicy.rewardedCloseTimeoutMs); });
    await tickSeconds(1);
    expect(screen.getByText(text("runtime.rewardedAdPending"))).toBeInTheDocument();
    expect(hasPendingFullscreenAd(fixture.sdk)).toBe(true);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it.each([
  { mandatory: true, countdownSeconds: 0 }, { mandatory: true, countdownSeconds: 3 },
  { mandatory: false, countdownSeconds: 0 }, { mandatory: false, countdownSeconds: 3 },
])("VIP 手动恢复等待旧原生关闭，释放后只消费一次手动意图：强弹=$mandatory，倒计时=$countdownSeconds", async ({ mandatory, countdownSeconds }) => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(countdownSeconds);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory={mandatory} onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    if (!mandatory) fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(countdownSeconds + 2);
    await act(async () => fixture.ads[0].error({ errorCode: "101150000", subErrorCode: "50008", errMsg: "container unavailable token=private" }));
    expect(hasPendingFullscreenAd(fixture.sdk)).toBe(true);
    const epoch = getVisibilitySnapshot().epoch;
    const retry = screen.getByRole("button", { name: text("vip.watchAd") });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await tickSeconds(2);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(screen.queryByText(text("runtime.rewardedAdPending"))).toBeNull();
    await act(async () => fixture.ads[0].close());
    await tickSeconds(2);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(true);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.visibilityEpoch).toBe(epoch);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fixture.runtime.getAdExperience().vipState.adCount).toBe(0);
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", error: "container unavailable token=[REDACTED]" }));
    expect(warns).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "vip_rewarded_ad_failed" }));
    // 手动意图只属于本次重试，后续强弹续播恢复为自动意图。
    await act(async () => fixture.ads[1].close());
    await tickSeconds(countdownSeconds + 2);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(mandatory ? 3 : 2);
    if (mandatory) expect(fixture.watchVIPAd.mock.calls[2][1]?.userInitiated).toBe(false);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it.each(["close", "unmount"] as const)("VIP 手动恢复等待时 %s 作废点击，迟到关闭不启动广告", async stop => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const content = (open: boolean) => <RuntimeContext.Provider value={fixture.runtime}><VipDialog open={open} onClose={vi.fn()} /></RuntimeContext.Provider>;
  const view = render(content(true));
  try {
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    if (stop === "close") view.rerender(content(false)); else view.unmount();
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    if (stop === "close") {
      view.rerender(content(true));
      await tickSeconds(3);
      expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
      await tickSeconds(1);
      expect(fixture.create).toHaveBeenCalledTimes(2);
    }
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it("VIP 等待检查通过后原生互斥再次占用，保留点击继续等待而非丢失恢复", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await act(async () => fixture.ads[0].close());
    // 调度检查时空闲，真正执行前又被其他原生广告占用，下一次检查才再次空闲。
    fixture.runtime.isFullscreenAdActive = vi.fn(() => isFullscreenAdBlockingPlayback(fixture.sdk))
      .mockReturnValueOnce(false).mockReturnValueOnce(true);
    await tickSeconds(4);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it.each([true, false])("VIP 手动等待切后台作废旧点击，回前台按当前入口恢复：强弹=%s", async mandatory => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const content = (visible: boolean) => <RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory={mandatory} visible={visible} onClose={vi.fn()} /></RuntimeContext.Provider>;
  const view = render(content(true));
  try {
    if (!mandatory) fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    fireEvent(window, new Event("pagehide"));
    // 首页自愿入口依赖生命周期订阅，须验证不更新 visible 时也会撤销旧点击。
    if (mandatory) view.rerender(content(false));
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    if (mandatory) view.rerender(content(true));
    fireEvent(window, new Event("pageshow"));
    await tickSeconds(2);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(mandatory ? 2 : 1);
    if (!mandatory) {
      fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
      await tickSeconds(1);
    }
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(!mandatory);
    expect(screen.queryByRole("alert")).toBeNull();
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it.each(["offer", "subject"] as const)("VIP 手动等待切换 %s 后不沿用旧点击", async target => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  let subject = "app:visitor-1";
  fixture.runtime.getSessionSubjectKey = () => subject;
  let offer = { offerId: "offer-1", kind: "rewarded_vip" } as AccessOffer;
  const content = () => <RuntimeContext.Provider value={fixture.runtime}><VipDialog open offer={offer} onClose={vi.fn()} /></RuntimeContext.Provider>;
  const view = render(content());
  try {
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    if (target === "offer") { offer = { ...offer, offerId: "offer-2" }; view.rerender(content()); }
    else subject = "app:visitor-2";
    await tickSeconds(1);
    await act(async () => fixture.ads[0].close());
    await tickSeconds(3);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd.mock.calls[1][0]).toBe(offer);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.isCurrent()).toBe(true);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it("VIP 手动等待期间暂停权益重查，确认后才消费原点击", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await act(async () => { fixture.updateExperience({ refreshRequired: true }); fixture.ads[0].close(); });
    await tickSeconds(5);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => fixture.updateExperience({ refreshRequired: false }));
    await tickSeconds(2);
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(true);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it.each(["active", "completed", "disabled"] as const)("VIP 手动等待期间服务端状态变为 %s，作废待展示意图", async state => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    const experience = fixture.runtime.getAdExperience();
    await act(async () => fixture.updateExperience(state === "disabled"
      ? { monetizationPolicy: { ...experience.monetizationPolicy, status: "disabled" } }
      : { vipState: { ...experience.vipState, active: state === "active", adCount: state === "completed" ? 2 : 0 } }));
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // 权益或策略恢复后也不能消费已作废的点击。
    await act(async () => fixture.updateExperience(experience));
    await tickSeconds(3);
    expect(fixture.watchVIPAd).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: text("vip.watchAd") })).toBeInTheDocument();
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});

it("VIP 手动等待超时保留原生互斥，未知结果停止恢复且不授予进度", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = nativeVIPRuntime(0);
  const view = render(<RuntimeContext.Provider value={fixture.runtime}><VipDialog open mandatory onClose={vi.fn()} /></RuntimeContext.Provider>);
  try {
    await tickSeconds(1);
    await act(async () => fixture.ads[0].error({ subErrorCode: "50008" }));
    fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(adPolicy.rewardedCloseTimeoutMs); });
    await tickSeconds(1);
    expect(screen.getByRole("alert")).toHaveTextContent(text("runtime.rewardedAdPending"));
    expect(hasPendingFullscreenAd(fixture.sdk)).toBe(true);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    expect(fixture.watchVIPAd.mock.calls[1][1]?.userInitiated).toBe(true);
    expect(fixture.runtime.getAdExperience().vipState.adCount).toBe(0);
    expect(warns.mock.calls.filter(([event]) => event.event === "vip_rewarded_ad_failed")).toHaveLength(2);
    await act(async () => fixture.ads[0].close());
    await tickSeconds(5);
    expect(fixture.watchVIPAd).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { view.unmount(); fixture.ads.forEach(ad => ad.close()); }
});
