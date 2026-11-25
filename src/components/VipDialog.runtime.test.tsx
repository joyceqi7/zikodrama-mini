import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { text } from "../copy";
import type { AccessOffer, AppConfig, SessionResult, VIPState } from "../domain/types";
import { hasPendingFullscreenAd } from "../platform/tiktok/fullscreenAd";
import type { RewardedAdCloseResult } from "../platform/tiktok/types";
import { RuntimeContext } from "../runtime/RuntimeContext";
import { createRuntime } from "../runtime/runtime";
import { createTikTokFixture } from "../test/tiktokFixture";
import { VipDialog } from "./VipDialog";

const session: SessionResult = {
  applicationId: "1", tiktokAppId: "test-app", visitorId: "11", visitorToken: "test-session-token",
  identityState: "tiktok_authenticated",
};
const config: AppConfig = {
  applicationId: "1", tiktokAppId: "test-app", appName: "Test Drama", logoUrl: "", complianceBaseUrl: "",
  playbackSdk: { provider: "tiktok_minis", channel: "byteplus" },
  monetization: {
    status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1,
    episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
    vip: { enabled: true, requiredAdCount: 2, title: "", content: "", entryAdCountdownSeconds: 0, requireBeforePlayback: true },
  },
};
const state: VIPState = { active: false, adCount: 0, requiredCount: 2, progressDate: "2026-11-03" };
const offer: AccessOffer = { offerId: "vip-offer", kind: "rewarded_vip", adUnitId: "vip-placement" };

interface ControlledAd {
  /** show 记录实际展示调用，不替代 Runtime 或广告适配器。 */
  show: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** close 只模拟未完播关闭，不能提供奖励凭据。 */
  close(): void;
  /** fail 在测试确认展示后注入 50008，不提前释放原生实例。 */
  fail(): void;
}

let platform: ReturnType<typeof createTikTokFixture>;
let ads: ControlledAd[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let vipResponse: Promise<Response> | undefined;

/** json 使用当前接口信封与服务器时间，保留真实 HTTP 客户端的合同校验。 */
function json(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: "", serverTime: new Date().toISOString(), data }));
}

/** requestCount 仅统计指定业务接口，正常的统计和错误日志发送不影响等待断言。 */
function requestCount(path: string): number {
  return fetcher.mock.calls.filter(([input]) => new URL(String(input), "https://mini.test").pathname === path).length;
}

/** tickSeconds 逐秒提交 React 更新，保留本地等待和异步 Offer 查询的先后关系。 */
async function tickSeconds(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // 每条广告独立维护回调，沿用真实适配器的 onClose/offClose 与原生互斥生命周期。
  platform = createTikTokFixture();
  ads = [];
  vi.mocked(platform.sdk.createRewardedVideoAd).mockImplementation(() => {
    const closeListeners = new Set<(result: RewardedAdCloseResult) => void>();
    const errorListeners = new Set<(reason: unknown) => void>();
    const show = vi.fn(async () => undefined);
    ads.push({
      show,
      close: () => [...closeListeners].forEach(listener => listener({ isEnded: false })),
      fail: () => [...errorListeners].forEach(listener => listener({ errorCode: "101150000", subErrorCode: "50008", errMsg: "container unavailable" })),
    });
    return {
      show,
      onClose: listener => { closeListeners.add(listener); },
      offClose: listener => { closeListeners.delete(listener); },
      onError: listener => { errorListeners.add(listener); },
      offError: listener => { errorListeners.delete(listener); },
    };
  });
  window.TTMinis = platform.sdk;

  // 只替换传输层，启动、Offer 查询、权益刷新和日志上报均经过真实 HTTP 客户端。
  vipResponse = undefined;
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input), "https://mini.test").pathname;
    switch (`${init?.method ?? "GET"} ${path}`) {
      case "GET /api/v1/open/app-config": return json(config);
      case "POST /api/v1/session": return json(session);
      case "GET /api/v1/me/vip": return vipResponse ?? json(state);
      case "GET /api/v1/me/vip/offer": return json({ offer });
      case "POST /api/v1/metrics":
      case "POST /api/v1/ad-errors": return json({ accepted: true });
      default: throw new Error(`测试未配置的请求：${path}`);
    }
  });
  vi.stubGlobal("fetch", fetcher);
});

afterEach(async () => {
  // 先卸载业务入口再关闭残留原生实例，避免强弹取消后在清理阶段创建下一条广告。
  cleanup();
  await act(async () => ads.forEach(ad => ad.close()));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.TTMinis;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([true, false])("实际 Runtime 手动恢复等待原生关闭，释放后只展示一次：强弹=%s", async mandatory => {
  const runtime = createRuntime();
  await runtime.bootstrap();
  await runtime.refreshAdExperience();
  const watch = vi.spyOn(runtime, "watchVIPAd");
  const claim = vi.spyOn(runtime.api, "claimReward");
  render(<RuntimeContext.Provider value={runtime}><VipDialog open mandatory={mandatory} onClose={() => {}} /></RuntimeContext.Provider>);
  if (!mandatory) fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await tickSeconds(2);
  expect(ads[0].show).toHaveBeenCalledOnce();
  await act(async () => ads[0].fail());
  expect(hasPendingFullscreenAd(platform.sdk)).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent(text("runtime.rewardedAdFailed"));

  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await tickSeconds(2);
  expect(watch).toHaveBeenCalledOnce();
  expect(requestCount("/api/v1/me/vip/offer")).toBe(1);
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledOnce();
  expect(ads[0].show).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();

  await act(async () => ads[0].close());
  await tickSeconds(3);
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls[1][1]?.userInitiated).toBe(true);
  expect(watch.mock.calls[1][1]?.isCurrent()).toBe(true);
  expect(requestCount("/api/v1/me/vip/offer")).toBe(2);
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledTimes(2);
  expect(ads[1].show).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(runtime.getAdExperience().vipState.adCount).toBe(0);
  expect(claim).not.toHaveBeenCalled();
  expect(platform.sdk.login).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", subErrorCode: "50008" }));
  expect(vi.mocked(console.warn).mock.calls.filter(([event]) => event.event === "vip_rewarded_ad_failed")).toHaveLength(1);
});

it("实际 Runtime 旧广告先关闭、前台权益重查后完成时，等待确认再自动恢复一次", async () => {
  const runtime = createRuntime();
  await runtime.bootstrap();
  await runtime.refreshAdExperience();
  let resolveVIP!: (response: Response) => void;
  vipResponse = new Promise<Response>(resolve => { resolveVIP = resolve; });
  const watch = vi.spyOn(runtime, "watchVIPAd");
  const claim = vi.spyOn(runtime.api, "claimReward");
  const content = (visible: boolean) => <RuntimeContext.Provider value={runtime}><VipDialog open mandatory visible={visible} onClose={() => {}} /></RuntimeContext.Provider>;
  const view = render(content(true));
  await tickSeconds(2);
  expect(ads[0].show).toHaveBeenCalledOnce();
  await act(async () => ads[0].fail());
  fireEvent.click(screen.getByRole("button", { name: text("vip.watchAd") }));
  await tickSeconds(1);
  expect(watch).toHaveBeenCalledOnce();

  // 后台往返作废旧手动意图；旧广告关闭不能代替服务端确认当前 VIP 状态。
  fireEvent(window, new Event("pagehide"));
  view.rerender(content(false));
  await act(async () => ads[0].close());
  expect(hasPendingFullscreenAd(platform.sdk)).toBe(false);
  view.rerender(content(true));
  fireEvent(window, new Event("pageshow"));
  await tickSeconds(2);
  expect(runtime.getAdExperience().refreshRequired).toBe(true);
  expect(requestCount("/api/v1/me/vip")).toBe(2);
  expect(requestCount("/api/v1/me/vip/offer")).toBe(1);
  expect(watch).toHaveBeenCalledOnce();
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledOnce();

  await act(async () => resolveVIP(json(state)));
  await tickSeconds(3);
  expect(runtime.getAdExperience().refreshRequired).toBe(false);
  expect(watch).toHaveBeenCalledTimes(2);
  expect(watch.mock.calls[1][1]?.userInitiated).toBe(false);
  expect(requestCount("/api/v1/me/vip/offer")).toBe(2);
  expect(platform.sdk.createRewardedVideoAd).toHaveBeenCalledTimes(2);
  expect(ads[1].show).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(runtime.getAdExperience().vipState.adCount).toBe(0);
  expect(claim).not.toHaveBeenCalled();
  expect(platform.sdk.login).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "rewarded_ad_callback_failed", subErrorCode: "50008" }));
  expect(vi.mocked(console.warn).mock.calls.filter(([event]) => event.event === "vip_rewarded_ad_failed")).toHaveLength(1);
});
