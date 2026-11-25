import { afterEach, expect, it, vi } from "vitest";
import { HttpMiniDramaApi } from "./httpMiniDramaApi";
import type { AppConfig, RewardClaim } from "../domain/types";

const claim: RewardClaim = { claimId: "settled-episode", offerId: "episode-offer", adUnitId: "ad", dramaId: "4", episodeId: "99" };
const serverTime = "2026-10-24T16:00:00Z";
const nextAd = { dramaId: "4", episodeId: "100", episodeNumber: 3, unlockedCount: 2, totalCount: 24,
  offer: { kind: "rewarded_episode", offerId: "next-offer", adUnitId: "ad", autoUnlock: { enabled: true, countdownSeconds: 30 } } };

/** response 保留奖励事实和下一集决策，只替换临时播放授权以覆盖不同回程时序。 */
function response(provider: "tiktok_minis" | "byteplus_web", status: "granted" | "already_granted" = "granted") {
  return { ...claim, status, rewardType: "episode_unlock", unlocked: true, nextAd,
    playback: { status: "playable", drama: { id: "4" }, episode: { id: "99" },
      playback: { channel: "byteplus", vid: "vid-99", ...(provider === "byteplus_web"
        ? { playAuthToken: "private-test-token", expiresAt: "2026-10-24T16:05:00Z" }
        : { albumId: "album", episodeId: "official-99" }) } } };
}

afterEach(() => vi.restoreAllMocks());

it.each(["granted", "already_granted"] as const)("%s 结算在两个播放器的正常及跨前后台回包中都保留奖励与下一集", async status => {
  for (const provider of ["tiktok_minis", "byteplus_web"] as const) {
    for (const invalidated of [false, true]) {
      let finish!: (value: Response) => void;
      const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
      const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
      api.configurePlayback({ playbackSdk: { provider } } as AppConfig);
      const pending = api.claimReward(claim);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      if (invalidated) api.invalidateTime();
      finish(new Response(JSON.stringify({ serverTime, data: response(provider, status) })));
      const result = await pending;
      expect(result).toMatchObject({ claimId: claim.claimId, status, unlocked: true, nextAd });
      if (provider === "byteplus_web" && invalidated) expect(result.playback).toBeUndefined();
      else expect(result.playback).toMatchObject({ status: "playable", playback: { provider } });
    }
  }
});

it.each(["expired", "no-server-time", "wrong-provider", "not-playable", "null"])("附带许可 %s 不可用时仍确认结算，日志不输出凭据", async reason => {
  const data = response("byteplus_web");
  let playback: unknown = data.playback;
  if (reason === "expired") playback = { ...data.playback, playback: { ...data.playback.playback, expiresAt: "2026-10-24T15:59:00Z" } };
  if (reason === "wrong-provider") playback = response("tiktok_minis").playback;
  if (reason === "not-playable") playback = { status: "unavailable" };
  if (reason === "null") playback = null;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const api = new HttpMiniDramaApi("https://api.example.test", async () => new Response(JSON.stringify({
    serverTime: reason === "no-server-time" ? undefined : serverTime, data: { ...data, playback },
  })));
  api.configurePlayback({ playbackSdk: { provider: "byteplus_web" } } as AppConfig);
  const result = await api.claimReward(claim);
  expect(result).toMatchObject({ status: "granted", unlocked: true, nextAd });
  expect(result.playback).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "reward_playback_refresh_required", outcome: "settlement_confirmed" }));
  expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain("private-test-token");
});

it("旧响应没有附带授权仍确认，普通播放接口对同样的失效许可继续拒绝", async () => {
  const { playback, ...old } = response("byteplus_web");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: old })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ serverTime, data: { ...playback,
      playback: { ...playback.playback, expiresAt: "2026-10-24T15:59:00Z" } } })));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  api.configurePlayback({ playbackSdk: { provider: "byteplus_web" } } as AppConfig);
  await expect(api.claimReward(claim)).resolves.toMatchObject(old);
  await expect(api.resolvePlay("4", "99")).rejects.toMatchObject({ code: "invalid_response" });
});

it.each([
  { claimId: "another-claim" }, { status: "pending" }, { rewardType: "unknown" }, { unlocked: undefined },
])("核心结算事实不合法仍拒绝：%j", async invalid => {
  const api = new HttpMiniDramaApi("https://api.example.test", async () => new Response(JSON.stringify({
    serverTime, data: { ...response("byteplus_web"), ...invalid },
  })));
  await expect(api.claimReward(claim)).rejects.toMatchObject({ code: "invalid_response" });
});
