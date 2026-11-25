import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import { VipDialog } from "./components/VipDialog";
import { PendingClaimStore } from "./domain/pendingClaims";
import { createMemoryStorage } from "./domain/browserStorage";
import type { AdExperience } from "./domain/types";
import { RuntimeContext } from "./runtime/RuntimeContext";
import type { Runtime } from "./runtime/runtime";
import { HttpMiniDramaApi } from "./api/httpMiniDramaApi";
import { TikTokMinisPlayerEngine } from "./player/tiktokMinisPlayerEngine";
import { OfficialTikTokMinisPlayerAdapter } from "./player/tiktokMinisPlayerAdapter";
import type { TikTokMinisSDK, TikTokVePlayerConstructor } from "./platform/tiktok/types";

const state = { active: false, adCount: 0, requiredCount: 1, progressDate: "day-1" };
const experience: AdExperience = { vipState: state, monetizationPolicy: {
  status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1,
  episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
  vip: { enabled: true, requiredAdCount: 1, title: "", content: "" },
} };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); delete window.TTMinis; window.location.hash = ""; });

it.each(["day-1", "day-2"])("VIP 已结算后失效，日期 %s 的旧结算快照不能继续显示已激活", async progressDate => {
  let current = experience;
  const runtime = { getAdExperience: () => current, subscribeAdExperience: () => () => {}, watchVIPAd: vi.fn(async () => {
    current = { ...current, vipState: { ...state, active: true } };
    return { vipState: current.vipState };
  }) } as unknown as Runtime;
  const show = (open: boolean) => <RuntimeContext.Provider value={runtime}><VipDialog open={open} onClose={() => {}} /></RuntimeContext.Provider>;
  const view = render(show(true)); fireEvent.click(screen.getByText("Watch sponsored video"));
  await screen.findByText("VIP active today");
  view.rerender(show(false));
  current = { ...current, vipState: { ...state, progressDate } };
  view.rerender(show(true));
  expect(screen.queryByText("VIP active today")).toBeNull();
  expect(screen.getByText("Watch sponsored video")).toBeInTheDocument();
});

it("VIP 弹窗需要用户点击，后台和前台切换均不会自动拉广告", async () => {
  const watchVIPAd = vi.fn(async () => null);
  const runtime = { getAdExperience: () => experience, subscribeAdExperience: () => () => {}, watchVIPAd } as unknown as Runtime;
  const show = (visible: boolean) => <RuntimeContext.Provider value={runtime}><VipDialog open visible={visible} onClose={() => {}} /></RuntimeContext.Provider>;
  const view = render(show(false)); await act(async () => {});
  expect(watchVIPAd).not.toHaveBeenCalled();
  view.rerender(show(true)); await act(async () => {});
  expect(watchVIPAd).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Watch sponsored video" }));
  expect(watchVIPAd).toHaveBeenCalledOnce();
});

it.each([false, true])("切集 SDK 事件与 Promise 不重复发状态，失败=%s 时不记成功指标", async failed => {
  const listeners = new Map<string, () => void>();
  class Player {
    player = { paused: false, play: vi.fn(), pause: vi.fn() };
    on(event: string, listener: () => void) { listeners.set(event, listener); }
    off() {} destroy() {}
    async playNext() { listeners.get("play_next_start")?.(); listeners.get("play_next_end")?.(); if (failed) throw new Error("switch failed"); }
  }
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player as unknown as TikTokVePlayerConstructor });
  const onSwitchingChange = vi.fn(); const onSwitchCompleted = vi.fn();
  const source = { channel: "byteplus" as const, albumId: "a", episodeId: "e1", vid: "v1" };
  await engine.mount(document.createElement("div"), source, { onSwitchingChange, onSwitchCompleted });
  const pending = engine.switchSource({ ...source, episodeId: "e2", vid: "v2" });
  if (failed) await expect(pending).rejects.toThrow("switch failed"); else await pending;
  expect(onSwitchingChange.mock.calls).toEqual([[true], [false]]);
  expect(onSwitchCompleted).toHaveBeenCalledTimes(failed ? 0 : 1);
  engine.destroy();
});

it("网络失败日志保留具体原因并脱敏，用户错误合同不变", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const api = new HttpMiniDramaApi("", vi.fn().mockRejectedValue(new TypeError("transport-disconnected token=private https://secret.example/a")));
  await expect(api.home()).rejects.toMatchObject({ message: "Network request failed" });
  const logs = JSON.stringify(log.mock.calls);
  expect(logs).toContain("transport-disconnected"); expect(logs).not.toContain("private"); expect(logs).not.toContain("secret.example");
});

it("响应解码失败记录真正原因，仍向页面返回统一错误", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = { status: 200, headers: new Headers(), json: async () => { throw new SyntaxError("bad json cookie=private"); } };
  const api = new HttpMiniDramaApi("", vi.fn().mockResolvedValue(response));
  await expect(api.home()).rejects.toMatchObject({ message: "Response could not be decoded", code: "invalid_response" });
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ error: "bad json cookie=[REDACTED]" }));
});

it("待领取存储异常保留错误详情并脱敏，成功恢复不误报失败", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const storage = createMemoryStorage();
  const read = vi.spyOn(storage, "getItem").mockImplementationOnce(() => { throw new Error("storage denied token=private"); });
  const store = new PendingClaimStore(storage, "app:A");
  expect(store.list()).toEqual([]);
  expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "pending_claim_storage_unavailable", error: "storage denied token=[REDACTED]" }));
  read.mockRestore(); log.mockClear();
  store.add({ claimId: "completed", offerId: "offer", adUnitId: "ad" });
  expect(store.list()).toHaveLength(1);
  expect(log).not.toHaveBeenCalled();
});

it("getPlayer 超时可重试，旧请求迟到不会覆盖新构造器", async () => {
  vi.useFakeTimers();
  let finish!: (constructor: TikTokVePlayerConstructor) => void;
  const Old = class {} as unknown as TikTokVePlayerConstructor;
  const New = class {} as unknown as TikTokVePlayerConstructor;
  const getPlayer = vi.fn().mockImplementationOnce(() => new Promise<TikTokVePlayerConstructor>(resolve => { finish = resolve; })).mockResolvedValue(New);
  const adapter = new OfficialTikTokMinisPlayerAdapter(() => ({ getPlayer }) as unknown as TikTokMinisSDK);
  const first = adapter.getConstructor();
  const rejected = expect(first).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(15_000); await rejected;
  await expect(adapter.getConstructor()).resolves.toBe(New);
  finish(Old); await act(async () => {});
  await expect(adapter.getConstructor()).resolves.toBe(New);
  expect(getPlayer).toHaveBeenCalledTimes(2);
});

it("SDK 初始化首次失败后重试会恢复录屏保护", async () => {
  let ready = false;
  const disableCapture = vi.fn(); const enableCapture = vi.fn();
  window.TTMinis = { disableCapture, enableCapture } as unknown as TikTokMinisSDK;
  const runtime = { getApplicationBrand: () => ({ name: "Test", logoUrl: "" }), getAdExperience: () => experience,
    subscribeAdExperience: () => () => {}, getLaunchTarget: () => undefined,
    bootstrap: vi.fn().mockRejectedValueOnce(new Error("SDK unavailable")).mockResolvedValue(undefined),
    whenPlatformReady: () => ready ? Promise.resolve() : Promise.reject(new Error("SDK unavailable")),
    loadPublicCatalog: vi.fn(async () => ({ dramas: [] })), loadHomeSections: vi.fn(async () => ({ carousel: [], hot: [], rankings: [] })),
    localLibrary: { history: () => [], follows: () => [] },
  } as unknown as Runtime;
  const view = render(<App runtime={runtime} />);
  const retry = await screen.findByRole("button", { name: "Retry" });
  ready = true; fireEvent.click(retry); await act(async () => {});
  expect(disableCapture).toHaveBeenCalledOnce();
  view.unmount(); expect(enableCapture).toHaveBeenCalledOnce();
});
