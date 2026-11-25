import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppConfig, PlaybackEntry, SessionResult } from "../domain/types";
import { remainingServerTime } from "../domain/serverTime";
import { getVisibilitySnapshot, observeVisibility } from "../platform/tiktok/lifecycle";
import { createTikTokFixture } from "../test/tiktokFixture";
import { createRuntime } from "./runtime";

const session: SessionResult = { applicationId: "1", tiktokAppId: "test-app", visitorId: "11", visitorToken: "fixture-session-token", identityState: "tiktok_authenticated" };
const config: AppConfig = { applicationId: "1", tiktokAppId: "test-app", appName: "Test", logoUrl: "", complianceBaseUrl: "",
  playbackSdk: { provider: "byteplus_web", channel: "byteplus", capabilities: { mediaPreload: false } },
  monetization: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 1, episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 }, vip: { enabled: true, requiredAdCount: 2, title: "", content: "" } } };
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, serverTime: "2026-10-24T10:00:00Z", data }));

beforeEach(() => {
  vi.useFakeTimers();
  // 手机日期故意远离服务端；期限判断只能依赖响应基准与单调时钟。
  vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
  vi.stubEnv("VITE_TIKTOK_APP_ID", "test-app");
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) });
  window.history.replaceState({}, "", "/?dramaId=drama&episodeId=episode");
});

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  delete window.TTMinis;
  window.history.replaceState({}, "", "/");
});

/** pendingLaunch 保留真实 API 校验与生命周期通知，可让更早订阅者同步恢复宿主前台。 */
async function pendingLaunch(validity: "playback" | "entry" | "vip" = "playback", reentrantForeground = false) {
  const platform = createTikTokFixture();
  const listeners = new Map<string, () => void>();
  platform.sdk.on = vi.fn((event, listener) => { listeners.set(event, listener); return event; });
  platform.sdk.off = vi.fn(() => true);
  window.TTMinis = platform.sdk;
  if (reentrantForeground) observeVisibility(platform.sdk, visible => {
    if (!visible) listeners.get("minis.show")!();
  });
  const drama = { id: "drama", firstEpisodeId: "episode", title: "Test", description: "", coverUrl: "", episodeCount: 1, tags: [], status: "ongoing" as const };
  const episode = { id: "episode", dramaId: drama.id, number: 1, title: "Episode 1", description: "", posterUrl: "", durationSeconds: 60, accessMode: "free" as const };
  const play = { status: "playable" as const, drama, episode, playback: { channel: "byteplus" as const, vid: "fixture-vid", posterUrl: "", title: episode.title,
    episodeNumber: 1, durationSeconds: 60, playAuthToken: "fixture-playback-token", expiresAt: "2026-10-24T10:05:00Z" } };
  const entry: PlaybackEntry = { target: { dramaId: drama.id, episodeId: episode.id }, drama, episode, play,
    entryAdStatus: validity === "entry" ? { enabled: true, scope: "user_drama", countBy: "completed", completedCount: 1, requiredCount: 1,
      validUntil: "2026-10-24T10:10:00Z", offer: { kind: "rewarded_entry", offerId: "fixture-offer", adUnitId: "fixture-ad" } } : { enabled: false, completedCount: 0, requiredCount: 0 },
    vipState: { active: validity === "vip", adCount: 0, requiredCount: 2, progressDate: "2026-10-24", ...(validity === "vip" ? { validUntil: "2026-10-24T10:10:00Z" } : {}) } };
  let visitorId = session.visitorId;
  let release!: (value: Response) => void;
  const firstEntry = new Promise<Response>(resolve => { release = resolve; });
  let entryRequests = 0;
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input).split("?")[0];
    if (path.endsWith("/open/app-config")) return response(config);
    if (path.endsWith("/session")) return response({ ...session, visitorId });
    if (path.endsWith("/play/entry")) return ++entryRequests === 1 ? firstEntry : response({ entry });
    if (path.endsWith("/play/resolve")) return response(play);
    if (path.endsWith("/me/vip")) return response(entry.vipState);
    return response({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const runtime = createRuntime();
  // 先接住拒绝，避免测试刻意制造的迟到响应变成未处理 Promise。
  const settled = runtime.bootstrap().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  await vi.waitFor(() => expect(entryRequests).toBe(1));
  return { runtime, fetcher, platform, settled, entry,
    release: () => release(response({ entry })),
    emit: (event: "minis.show" | "minis.hide") => listeners.get(event)!(),
    setVisitor: (next: string) => { visitorId = next; } };
}

it.each(["playback", "entry", "vip"] as const)("首次宿主前台确认保留在途 %s 期限与同一可见周期的播放许可，不额外刷新 VIP", async validity => {
  const h = await pendingLaunch(validity);
  const authorization = await h.runtime.resolvePlayback!("drama", "episode");
  if (authorization.status !== "playable") throw new Error("缺少服务端播放许可");
  const epoch = getVisibilitySnapshot().epoch;
  const revision = h.runtime.getEntitlementRevision!();
  expect(getVisibilitySnapshot()).toMatchObject({ nativeVisibility: "unknown", visible: true });
  expect(remainingServerTime(authorization.playback)).toBeGreaterThan(290_000);
  h.emit("minis.show");
  expect(getVisibilitySnapshot()).toMatchObject({ nativeVisibility: "visible", visible: true, epoch: epoch + 1 });
  expect(remainingServerTime(authorization.playback)).toBeGreaterThan(290_000);
  expect(await h.runtime.resolvePlayback!("drama", "episode")).toBe(authorization);
  expect(h.runtime.getEntitlementRevision!()).toBe(revision);
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/me/vip"))).toHaveLength(0);
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"))).toHaveLength(1);
  expect(h.runtime.getLaunchTarget()).toBeUndefined();
  h.release();
  await expect(h.settled).resolves.toEqual({ ok: true });
  expect(h.runtime.getLaunchTarget()).toEqual(h.entry.target);
  expect(h.platform.sdk.login).toHaveBeenCalledOnce();
});

it("真正隐藏再显示仍作废旧许可与在途 entry；仅明确重试重新验权，不重新登录", async () => {
  const h = await pendingLaunch();
  const authorization = await h.runtime.resolvePlayback!("drama", "episode");
  if (authorization.status !== "playable") throw new Error("缺少服务端播放许可");
  h.emit("minis.hide"); h.emit("minis.show");
  expect(remainingServerTime(authorization.playback)).toBe(0);
  h.release();
  await expect(h.settled).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } });
  expect(h.runtime.getLaunchTarget()).toBeUndefined();
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"))).toHaveLength(1);
  await h.runtime.bootstrap();
  expect(h.runtime.getLaunchTarget()).toEqual(h.entry.target);
  const current = await h.runtime.resolvePlaybackEntry!("drama", "episode");
  if (current.play?.status !== "playable") throw new Error("缺少重新确认的播放许可");
  expect(remainingServerTime(current.play.playback)).toBeGreaterThan(290_000);
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"))).toHaveLength(2);
  expect(h.platform.sdk.login).toHaveBeenCalledOnce();
});

it("更早订阅者同步 hide→show 时，Runtime 只收到 true 仍撤销旧 resolve 许可与缓存", async () => {
  const h = await pendingLaunch("playback", true);
  h.release();
  await expect(h.settled).resolves.toEqual({ ok: true });
  h.runtime.invalidatePlayback!();
  const authorization = await h.runtime.resolvePlayback!("drama", "episode");
  if (authorization.status !== "playable") throw new Error("缺少服务端播放许可");
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).split("?", 1)[0].endsWith("/play/resolve"))).toHaveLength(1);
  const epoch = getVisibilitySnapshot().epoch;
  expect(getVisibilitySnapshot()).toMatchObject({ nativeVisibility: "unknown", visible: true });
  h.emit("minis.hide");
  expect(getVisibilitySnapshot()).toMatchObject({ nativeVisibility: "visible", visible: true, epoch: epoch + 2 });
  expect(remainingServerTime(authorization.playback)).toBe(0);
  await h.runtime.refreshAdExperience();
  const current = await h.runtime.resolvePlayback!("drama", "episode");
  if (current.status !== "playable") throw new Error("缺少重新确认的播放许可");
  expect(current).not.toBe(authorization);
  expect(remainingServerTime(current.playback)).toBeGreaterThan(290_000);
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).split("?", 1)[0].endsWith("/play/resolve"))).toHaveLength(2);
  expect(h.platform.sdk.login).toHaveBeenCalledOnce();
});

it("首次 show 不放行换号前的许可和迟到 entry，也不把旧目标安装到新身份", async () => {
  const h = await pendingLaunch();
  const authorization = await h.runtime.resolvePlayback!("drama", "episode");
  if (authorization.status !== "playable") throw new Error("缺少服务端播放许可");
  h.setVisitor("22");
  await h.runtime.api.createSession({ tiktokAppId: "test-app", launchQuery: {} });
  h.emit("minis.show");
  expect(remainingServerTime(authorization.playback)).toBe(0);
  h.release();
  await expect(h.settled).resolves.toMatchObject({ ok: false, error: { code: "identity_changed" } });
  expect(h.runtime.getVisitorID()).toBe("22");
  expect(h.runtime.getLaunchTarget()).toBeUndefined();
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/play/entry"))).toHaveLength(1);
});
