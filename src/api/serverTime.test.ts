import { afterEach, expect, it, vi } from "vitest";
import { HttpMiniDramaApi } from "./httpMiniDramaApi";
import { remainingServerTime } from "../domain/serverTime";
import { validateDirectSource } from "../player/vePlayerEngine";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const serverTime = "2026-10-23T12:00:00Z";
const boot = { applicationId: "101", visitorId: "9007199254740993", visitorToken: "test-only-token", tiktokAppId: "test-app",
  playbackSdk: { provider: "byteplus_web", channel: "byteplus", capabilities: { mediaPreload: false } } };
const playback = { status: "playable", drama: { id: "201" }, episode: { id: "301" },
  playback: { channel: "byteplus", vid: "test-vid", playAuthToken: "test-only-playback-token", expiresAt: "2026-10-23T12:01:00Z" } };
const response = (data: unknown, base: unknown = serverTime) => new Response(JSON.stringify({ code: 0, data, serverTime: base }));

it.each([-24, 24])("设备日期偏差 %s 小时，HTTP 及播放器两处均按服务器期限验权；后台旧许可失效", async hours => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(serverTime) + hours * 3600_000);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(boot))
    .mockResolvedValueOnce(response(playback)).mockResolvedValueOnce(response(playback));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  await api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} });
  const first = await api.resolvePlay("201", "301");
  if (first.status !== "playable") throw new Error("缺少许可");
  expect(remainingServerTime(first.playback)).toBeGreaterThan(59_000);
  expect(() => validateDirectSource(first.playback)).not.toThrow();
  vi.setSystemTime(new Date("2036-01-01T00:00:00Z"));
  expect(() => validateDirectSource(first.playback)).not.toThrow();
  api.invalidateTime();
  expect(() => validateDirectSource(first.playback)).toThrow();
  await expect(api.resolvePlay("201", "301")).resolves.toMatchObject({ status: "playable" });
});

it.each([undefined, "invalid"])("缺失或无效基准 %s 时直连和入剧状态只返回一次受控错误", async base => {
  const unconfirmed = (data: unknown) => base === undefined ? new Response(JSON.stringify({ code: 0, data })) : response(data, base);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(boot))
    .mockResolvedValueOnce(unconfirmed(playback))
    .mockResolvedValueOnce(unconfirmed({ enabled: true, scope: "user", countBy: "completed", completedCount: 0, requiredCount: 1,
      validUntil: "2026-10-23T12:01:00Z", offer: { kind: "rewarded_entry", offerId: "entry", adUnitId: "ad" } }));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  await api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} });
  await expect(api.resolvePlay("201", "301")).rejects.toMatchObject({ code: "invalid_response" });
  await expect(api.entryAdStatus("201")).rejects.toMatchObject({ code: "invalid_response" });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "api_response_rejected", error: "Playback authorization lifetime is unconfirmed or insufficient" }));
  expect(JSON.stringify(warning.mock.calls)).not.toContain("test-only-playback-token");
});

it("本地补报保留期元数据不进入 API；新展示无需提交手机时间", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ accepted: true }));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  await api.recordAdShow({ eventId: "receipt-key", scene: "home_entry", adUnitId: "ad", queuedAtServer: 123 });
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ eventId: "receipt-key", scene: "home_entry", adUnitId: "ad" });
});

it("缺少业务结果时保留请求关联和实际原因，日志不输出完整响应", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, serverTime, token: "private-test-token" }), { headers: { "x-request-id": "missing-data" } }));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  await expect(api.entryAdStatus("201")).rejects.toMatchObject({ status: 200, code: "invalid_response", requestId: "missing-data" });
  expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "api_response_rejected", error: "Response data is missing" }));
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-test-token");
});
