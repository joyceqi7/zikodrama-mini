import { afterEach, expect, it, vi } from "vitest";
import type { DramaDetail } from "../domain/types";
import { TikTokEventReporter } from "../platform/tiktok/events";
import type { TikTokMinisSDK, TikTokVePlayerOptions } from "../platform/tiktok/types";
import { TikTokMinisPlayerEngine } from "./tiktokMinisPlayerEngine";

// 官方 SDK 替身仅模拟事件顺序和失败，不调用真实平台。
class Player {
  static current: Player;
  static failure: unknown;
  listeners = new Map<string, (payload?: unknown) => void>();
  player = { currentTime: 0, duration: 60, paused: true, ended: false, play: vi.fn(), pause: vi.fn() };
  constructor(_options: TikTokVePlayerOptions) {
    if (Player.failure) throw Player.failure;
    Player.current = this;
  }
  on(event: string, callback: (payload?: unknown) => void) { this.listeners.set(event, callback); }
  off(event: string) { this.listeners.delete(event); }
  destroy() {}
  playNext = vi.fn(async (_options: TikTokVePlayerOptions) => undefined);
}
const source = { channel: "byteplus" as const, albumId: "album", episodeId: "platform-1", vid: "vid-1" };
it("续播定位废弃已排队旧帧，定位完成重新观察帧而不等待时间更新", async () => {
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  const frames: VideoFrameRequestCallback[] = [];
  const onFirstFrame = vi.fn();
  await engine.mount(document.createElement("div"), source, { onFirstFrame });
  const video = document.createElement("video");
  video.requestVideoFrameCallback = callback => { frames.push(callback); return frames.length; };
  video.cancelVideoFrameCallback = vi.fn();
  Object.assign(Player.current.player, { video, seek: vi.fn() });
  Player.current.listeners.get("playing")?.();
  engine.seek(30);
  frames[0](0, {} as VideoFrameCallbackMetadata);
  expect(onFirstFrame).not.toHaveBeenCalled();
  Player.current.listeners.get("playing")?.();
  frames[1](0, {} as VideoFrameCallbackMetadata);
  onFirstFrame.mockClear();
  Player.current.listeners.get("seeked")?.();
  expect(frames).toHaveLength(3);
  frames[2](0, {} as VideoFrameCallbackMetadata);
  expect(onFirstFrame).toHaveBeenCalledExactlyOnceWith("vid-1");
  engine.destroy();
});
afterEach(() => { Player.failure = undefined; vi.restoreAllMocks(); });

it("准备完成后的起播拒绝记录脱敏原因，不产生未处理拒绝", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const blocked = vi.fn();
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  await engine.mount(document.createElement("div"), { ...source, autoplay: false }, { onAutoplayBlocked: blocked });
  const kernel = Player.current.player;
  kernel.play.mockRejectedValueOnce(new Error("play denied token=private-value"));
  Object.defineProperty(Player.current, "player", { configurable: true, value: undefined });
  await engine.play();
  Object.defineProperty(Player.current, "player", { configurable: true, value: kernel });
  Player.current.listeners.get("ready")?.();
  await Promise.resolve(); await Promise.resolve();
  expect(blocked).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "official_prepared_resume_failed", error: expect.stringContaining("play denied") }));
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-value");
  engine.destroy();
});

it("暂停准备切源不补发播放，READY 前的播放意图只执行一次且暂停可以撤销", async () => {
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  await engine.mount(document.createElement("div"), { ...source, autoplay: false });
  await engine.switchSource({ ...source, vid: "next", autoplay: false });
  expect(Player.current.playNext).toHaveBeenCalledWith(expect.objectContaining({ autoplay: false }));
  const kernel = Player.current.player;
  expect(kernel.play).not.toHaveBeenCalled();
  Object.defineProperty(Player.current, "player", { configurable: true, value: undefined });
  await engine.play();
  Object.defineProperty(Player.current, "player", { configurable: true, value: kernel });
  Player.current.listeners.get("ready")?.();
  Player.current.listeners.get("complete")?.();
  expect(kernel.play).toHaveBeenCalledOnce();
  Object.defineProperty(Player.current, "player", { configurable: true, value: undefined });
  await engine.play(); engine.pause();
  Object.defineProperty(Player.current, "player", { configurable: true, value: kernel });
  Player.current.listeners.get("ready")?.();
  expect(kernel.play).toHaveBeenCalledOnce();
  engine.destroy();
});

it("切源完成先通知续播就绪，不等待播放 Promise 才 seek 或接收进度", async () => {
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  const onReady = vi.fn();
  await engine.mount(document.createElement("div"), source, { onReady });
  Player.current.player.play.mockImplementation(() => new Promise(() => undefined));
  let completed = false;
  void engine.switchSource({ ...source, vid: "next" }).then(() => { completed = true; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(onReady).toHaveBeenCalledOnce();
  expect(completed).toBe(true);
  engine.destroy();
});

it("切源期间以新媒体实际播放结束等待，旧监听不能向新集交付首帧", async () => {
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  const onFirstFrame = vi.fn();
  await engine.mount(document.createElement("div"), source, { onFirstFrame });
  const oldPlaying = Player.current.listeners.get("playing")!;
  let finish!: () => void;
  Player.current.playNext.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
  const pending = engine.switchSource({ ...source, vid: "next" });
  await Promise.resolve(); await Promise.resolve();
  oldPlaying();
  expect(onFirstFrame).not.toHaveBeenCalled();
  Player.current.listeners.get("playing")!();
  expect(onFirstFrame).not.toHaveBeenCalled();
  Player.current.player.currentTime = 0.1;
  Player.current.player.paused = false;
  Player.current.listeners.get("timeupdate")!();
  expect(onFirstFrame).not.toHaveBeenCalled();
  finish(); await pending;
  Player.current.listeners.get("timeupdate")!();
  expect(onFirstFrame).toHaveBeenCalledExactlyOnceWith("next");
  Player.current.listeners.get("playing")!();
  expect(onFirstFrame).toHaveBeenCalledOnce();
  engine.destroy();
});

it("请求播放后立即失败不回传 ep_play，实际播放和恢复只计一次，切集独立计数", async () => {
  const reportEvent = vi.fn();
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK);
  const drama = { id: "drama", title: "短剧", episodes: [{ id: "ep-1", number: 1 }, { id: "ep-2", number: 2 }] } as DramaDetail;
  let episode = "ep-1";
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player },);
  vi.spyOn(console, "error").mockImplementation(() => {});
  reporter.playback("video_play_request", drama, episode);
  await engine.mount(document.createElement("div"), source, { onPlay: () => reporter.playback("ep_play", drama, episode) });
  Player.current.listeners.get("play")?.();
  Player.current.listeners.get("error")?.(new Error("decoder failed before first frame"));
  const eventNames = () => reportEvent.mock.calls.map(([input]) => input.eventName);
  expect(eventNames()).toEqual(["video_play_request"]);
  Player.current.listeners.get("playing")?.();
  Player.current.listeners.get("playing")?.();
  expect(eventNames()).toEqual(["video_play_request", "ep_play"]);
  episode = "ep-2";
  reporter.playback("video_play_request", drama, episode);
  await engine.switchSource({ ...source, episodeId: "platform-2", vid: "vid-2" });
  Player.current.listeners.get("play")?.();
  expect(eventNames()).toEqual(["video_play_request", "ep_play", "video_play_request"]);
  Player.current.listeners.get("playing")?.();
  expect(eventNames()).toEqual(["video_play_request", "ep_play", "video_play_request", "ep_play"]);
  engine.destroy();
});

it("初始化、切集和事件故障记录具体原因并脱敏，成功路径不报错", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player },);
  const failure = new Error("decoder unavailable token=private-token https://media.example/video?signature=private-signature");
  Player.failure = failure;
  await expect(engine.mount(document.createElement("div"), source)).rejects.toBe(failure);
  expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ event: "official_playback_mount_failed", error: expect.stringContaining("decoder unavailable") }));
  Player.failure = undefined;
  log.mockClear();
  const onError = vi.fn();
  await engine.mount(document.createElement("div"), source, { onError });
  Player.current.listeners.get("playing")?.();
  expect(log).not.toHaveBeenCalled();
  Player.current.playNext.mockRejectedValueOnce(failure);
  await expect(engine.switchSource({ ...source, vid: "vid-2" })).rejects.toBe(failure);
  expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ event: "official_playback_source_switch_failed", error: expect.stringContaining("decoder unavailable") }));
  Player.current.listeners.get("error")?.({ message: failure.message, token: "hidden-object-secret" });
  expect(onError).toHaveBeenCalledOnce();
  expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ event: "official_playback_error", error: expect.stringContaining("decoder unavailable") }));
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|media\.example|private-signature|hidden-object-secret/);
  engine.destroy();
});

it("串行切源屏蔽旧事件，过期切源失败不能破坏最新剧集", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  const onPlay = vi.fn();
  const onFirstFrame = vi.fn();
  await engine.mount(document.createElement("div"), source, { onPlay, onFirstFrame });
  let rejectOld!: (reason: Error) => void;
  Player.current.playNext.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const old = engine.switchSource({ ...source, vid: "old" });
  await Promise.resolve(); await Promise.resolve();
  const latest = engine.switchSource({ ...source, vid: "latest" });
  Player.current.listeners.get("playing")?.();
  expect(onPlay).not.toHaveBeenCalled();
  expect(onFirstFrame).not.toHaveBeenCalled();
  expect(Player.current.playNext).toHaveBeenCalledTimes(1);
  rejectOld(new Error("old request failed"));
  await old; await latest;
  expect(Player.current.playNext).toHaveBeenLastCalledWith(expect.objectContaining({ vid: "latest" }));
  Player.current.listeners.get("playing")?.();
  expect(onPlay).toHaveBeenCalledOnce();
  const delayed = Player.current.listeners.get("playing")!;
  engine.destroy(); delayed();
  expect(onPlay).toHaveBeenCalledOnce();
});
