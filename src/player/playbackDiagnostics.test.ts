import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TikTokVePlayerInstance } from "../platform/tiktok/types";
import { TikTokMinisPlayerEngine } from "./tiktokMinisPlayerEngine";
import { playbackErrorFields, playbackMediaFields, playbackResourceFields } from "./playbackDiagnostics";

const source = { provider: "tiktok_minis" as const, channel: "byteplus" as const, albumId: "album", episodeId: "episode", vid: "video" };

function fixture() {
  let instance!: Player;
  class Player implements TikTokVePlayerInstance {
    readonly listeners = new Map<string, (payload?: unknown) => void>();
    readonly video = document.createElement("video");
    readonly player = { video: this.video, currentTime: 0, duration: 60, paused: true, muted: false, play: vi.fn(async () => undefined), pause: vi.fn() };
    readonly playNext = vi.fn(async () => undefined);
    readonly destroy = vi.fn();
    constructor() {
      instance = this;
      Object.defineProperties(this.video, {
        readyState: { value: 0 }, networkState: { value: 2 },
        error: { value: { code: 4 } },
        // 通用事件诊断不读地址；只有单次媒体网络采样测试会配置一个匹配样本。
        currentSrc: { value: "", configurable: true },
      });
    }
    on(event: string, listener: (payload?: unknown) => void) { this.listeners.set(event, listener); }
    off(event: string) { this.listeners.delete(event); }
  }
  return { engine: new TikTokMinisPlayerEngine({ getConstructor: async () => Player }), instance: () => instance };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("SDK 错误保留数值细分码与实际消息，凭据和原始响应不写入日志且业务回调不变", async () => {
  const { engine, instance } = fixture();
  const onError = vi.fn();
  await engine.mount(document.createElement("div"), source, { onError });
  const reason = { errorCode: 6, veErrorCode: "2103", message: "Forbidden https://media.test/video?signature=private token=private", response: { authorization: "private" } };
  instance().listeners.get("error")?.(reason);
  expect(onError).toHaveBeenCalledExactlyOnceWith(reason);
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({
    event: "official_playback_error", errorCode: "6", veErrorCode: "2103", playerEvent: "error",
    mediaErrorCode: 4, networkState: 2, error: "Forbidden [URL] token=[REDACTED]",
  }));
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(console.warn).not.toHaveBeenCalled();
  engine.destroy();
});

it("取播放地址与 License 警告分别记录，诊断不额外触发业务错误或 SDK 重试", async () => {
  const { engine, instance } = fixture();
  const onError = vi.fn();
  await engine.mount(document.createElement("div"), source, { onError });
  instance().listeners.get("get_play_url_err")?.({ error: { code: 401, Message: "VOD authorization denied cookie=private" } });
  instance().listeners.get("license_status_warning")?.({ veErrorCode: 1001, error_msg: "License domain mismatch" });
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ event: "player_source_request_failed", playerEvent: "get_play_url_err", errorCode: "401", error: "VOD authorization denied cookie=[REDACTED]" }));
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "player_license_warning", veErrorCode: "1001", error: "License domain mismatch" }));
  expect(onError).not.toHaveBeenCalled();
  expect(instance().playNext).not.toHaveBeenCalled();
  engine.destroy();
});

it("非终态取流错误后仍保留一次等待采样，不重试或提前结束加载", async () => {
  const { engine, instance } = fixture();
  const onError = vi.fn();
  const onPlay = vi.fn();
  await engine.mount(document.createElement("div"), source, { onError, onPlay });
  await vi.advanceTimersByTimeAsync(350);
  instance().listeners.get("get_play_url_err")?.({ message: "Source request failed token=private" });
  expect(console.info).toHaveBeenCalledWith(expect.objectContaining({ event: "player_media_event", playerEvent: "get_play_url_err", elapsedMs: 350 }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "player_startup_pending", playerEvent: "get_play_url_err" }));
  expect(onError).not.toHaveBeenCalled();
  expect(onPlay).not.toHaveBeenCalled();
  expect(instance().playNext).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private");
  engine.destroy();
});

it("前台一直加载时只采样一次并保留最后媒体事件，销毁后不再记录", async () => {
  const { engine, instance } = fixture();
  await engine.mount(document.createElement("div"), source);
  instance().listeners.get("loadstart")?.();
  instance().listeners.get("loadedmetadata")?.();
  instance().listeners.get("loadedmetadata")?.();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    event: "player_startup_pending", playerEvent: "loadedmetadata", readyState: 0, networkState: 2, mediaErrorCode: 4,
  }));
  expect(vi.mocked(console.info).mock.calls.filter(([record]) => record.event === "player_media_event" && record.playerEvent === "loadedmetadata")).toHaveLength(1);
  engine.destroy();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(console.warn).toHaveBeenCalledOnce();
});

it.each(["pause", "destroy", "background", "first_frame"])("%s 后不误报仍在前台等待出画", async action => {
  const { engine, instance } = fixture();
  await engine.mount(document.createElement("div"), source);
  if (action === "pause") engine.pause();
  if (action === "destroy") engine.destroy();
  if (action === "background") vi.mocked(Object.getOwnPropertyDescriptor(document, "hidden")!.get!).mockReturnValue(true);
  if (action === "first_frame") {
    instance().player.paused = false;
    instance().player.currentTime = 1;
    instance().listeners.get("playing")?.();
    instance().listeners.get("timeupdate")?.();
  }
  await vi.advanceTimersByTimeAsync(15_000);
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  engine.destroy();
});

it("切源后旧集的等待计时和监听不归属到新集", async () => {
  const { engine, instance } = fixture();
  await engine.mount(document.createElement("div"), source);
  const oldError = instance().listeners.get("error");
  await vi.advanceTimersByTimeAsync(10_000);
  await engine.switchSource({ ...source, vid: "next-video", episodeId: "next-episode" });
  oldError?.(new Error("obsolete failure"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(console.warn).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "player_startup_pending", vid: "next-video" }));
  engine.destroy();
});

it("SDK 对象只提取消息和数值错误码，媒体诊断不包含完整内核", () => {
  expect(playbackErrorFields({ errorCode: "private-token", veErrorCode: {}, errorMessage: "SDK failed signature=private" }, "Unknown")).toMatchObject({ error: "SDK failed signature=[REDACTED]", errorCode: undefined, veErrorCode: undefined });
  expect(playbackMediaFields()).toMatchObject({ mediaPresent: false, networkState: undefined });
});

it("首帧只采样本次播放且已完成的同源媒体请求，脱敏后不输出签名地址", async () => {
  const { engine, instance } = fixture();
  const onFirstFrame = vi.fn();
  await engine.mount(document.createElement("div"), source, { onFirstFrame });
  const address = "https://media.test/episode?signature=private";
  Object.defineProperty(instance().video, "currentSrc", { value: address });
  const timeline = vi.fn(() => [
    { startTime: -100, responseEnd: 5, duration: 105 },
    { startTime: 10, connectStart: 11, connectEnd: 16, requestStart: 17, responseStart: 27, responseEnd: 52, duration: 42 },
  ]);
  const original = Object.getOwnPropertyDescriptor(performance, "getEntriesByName");
  Object.defineProperty(performance, "getEntriesByName", { configurable: true, value: timeline });
  try {
    let frame!: VideoFrameRequestCallback;
    instance().video.requestVideoFrameCallback = callback => { frame = callback; return 1; };
    instance().player.paused = false;
    instance().listeners.get("playing")?.();
    frame(60, { processingDuration: 0.004 } as VideoFrameCallbackMetadata);
    expect(onFirstFrame).toHaveBeenCalledExactlyOnceWith(source.vid);
    expect(timeline).toHaveBeenCalledExactlyOnceWith(address, "resource");
    expect(console.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "official_playback_first_frame", mediaConnectMs: 5, mediaResponseWaitMs: 10,
      mediaResponseTransferMs: 25, mediaRequestDurationMs: 42, frameProcessingMs: 4,
    }));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("private");
    timeline.mockReturnValueOnce([{ startTime: 10, connectStart: 0, connectEnd: 0, requestStart: 0,
      responseStart: 0, responseEnd: 52, duration: 42 }]);
    expect(playbackResourceFields(instance(), 0)).toMatchObject({
      mediaRequestDurationMs: 42, mediaConnectMs: undefined, mediaResponseWaitMs: undefined, mediaResponseTransferMs: undefined,
    });
  } finally {
    if (original) Object.defineProperty(performance, "getEntriesByName", original);
    else Reflect.deleteProperty(performance, "getEntriesByName");
    engine.destroy();
  }
});

it("宿主收回媒体属性时诊断失败仍传递原来的业务错误", async () => {
  const { engine, instance } = fixture();
  const onError = vi.fn();
  await engine.mount(document.createElement("div"), source, { onError });
  Object.defineProperty(instance().player, "video", { get() { throw new Error("Host denied media access token=private"); } });
  const reason = new Error("Playback denied");
  instance().listeners.get("error")?.(reason);
  expect(onError).toHaveBeenCalledExactlyOnceWith(reason);
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "player_media_diagnostic_failed", error: "Host denied media access token=[REDACTED]" }));
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private");
  engine.destroy();
});

it("自动播放被拒绝和 play Promise 拒绝均记录详情，不改变回调与拒绝结果", async () => {
  const { engine, instance } = fixture();
  const blocked = vi.fn();
  await engine.mount(document.createElement("div"), { ...source, autoplay: false }, { onAutoplayBlocked: blocked });
  const reason = new DOMException("User gesture required token=private", "NotAllowedError");
  instance().player.play.mockRejectedValueOnce(reason);
  await expect(engine.play()).rejects.toBe(reason);
  instance().listeners.get("autoplay_was_prevented")?.(reason);
  expect(blocked).toHaveBeenCalledExactlyOnceWith(false);
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "player_play_request_failed", error: "User gesture required token=[REDACTED]" }));
  expect(console.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "player_autoplay_blocked", playerEvent: "autoplay_was_prevented" }));
  expect(console.error).not.toHaveBeenCalled();
  engine.destroy();
});
