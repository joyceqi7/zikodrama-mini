import { describe, expect, it, vi } from "vitest";

import type {
  TikTokVePlayerInstance,
  TikTokVePlayerOptions,
} from "../platform/tiktok/types";
import type { PlaybackSource } from "./playbackEngine";
import {
  officialPlayerOptions,
  TikTokMinisPlayerEngine,
} from "./tiktokMinisPlayerEngine";

function source(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    channel: "byteplus",
    albumId: "album-1",
    episodeId: "episode-platform-1",
    vid: "vid-1",
    posterUrl: "https://images.example/poster.jpg",
    ...overrides,
  };
}

describe("officialPlayerOptions", () => {
  it("启用短剧需要的官方 UI 并关闭不适用的宿主能力", () => {
    const options = officialPlayerOptions(source(), document.createElement("div"));

    expect(options).toMatchObject({
      albumId: "album-1",
      episodeId: "episode-platform-1",
      vid: "vid-1",
      getVideoByToken: { needPoster: true },
      autoSubtitle: false,
      closeVideoDblclick: true,
      ignores: [
        "moreButtonPlugin",
        "enter",
        "fullscreen",
        "volume",
        "play",
        "pip",
        "replay",
        "playbackrate",
        "miniProgress",
        "sdkDefinitionPlugin",
        "Subtitle",
      ],
      commonStyle: { playedColor: "#ffffff" },
      mobile: { gradient: "none" },
      sdkErrorPlugin: { isNeedRefreshButton: false },
      start: { disableAnimate: true, isShowPause: true },
    });
    expect(options).not.toHaveProperty("poster");
    expect(options).not.toHaveProperty("playList");
    expect(options).not.toHaveProperty("defaultDefinition");
    expect(options).not.toHaveProperty("url");
    expect(options.ignores).not.toContain("progress");
  });

  it("通过官方媒体信息查询启用 BytePlus 分集封面且不提供旧版 Token", () => {
    const options = officialPlayerOptions(source());
    expect(options.getVideoByToken).toEqual({ needPoster: true });
    expect(officialPlayerOptions(source({ posterUrl: undefined })).getVideoByToken).toEqual({ needPoster: true });
    expect(options.getVideoByToken).not.toHaveProperty("playAuthToken");
    expect(options).not.toHaveProperty("poster");
  });
});

describe("TikTokMinisPlayerEngine", () => {
  it("原生视频帧回调失联时用已推进的播放时间撤销首图", async () => {
    vi.useFakeTimers();
    try {
      class FrameCallbackPlayer implements TikTokVePlayerInstance {
        static Events = { PLAYING: "playing", TIME_UPDATE: "timeupdate" };
        readonly listeners = new Map<string, (payload?: unknown) => void>();
        readonly cancelVideoFrameCallback = vi.fn();
        readonly video = document.createElement("video");
        readonly player = {
          currentTime: 0.1,
          duration: 60,
          ended: false,
          play: vi.fn(async () => undefined),
          pause: vi.fn(),
          video: this.video,
        };
        readonly playNext = vi.fn(async () => undefined);
        readonly destroy = vi.fn();
        constructor() {
          Object.defineProperties(this.video, {
            readyState: { value: 4, configurable: true },
            requestVideoFrameCallback: { value: vi.fn(() => 7), configurable: true },
            cancelVideoFrameCallback: { value: this.cancelVideoFrameCallback, configurable: true },
          });
        }
        on(event: string, listener: (payload?: unknown) => void) { this.listeners.set(event, listener); }
        off(event: string) { this.listeners.delete(event); }
      }
      const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => FrameCallbackPlayer });
      const onFirstFrame = vi.fn();
      await engine.mount(document.createElement("div"), source(), { onFirstFrame });
      // 通过构造器替身取实例，模拟 WKWebView 不兑现 requestVideoFrameCallback。
      const instance = (engine as unknown as { instance: FrameCallbackPlayer }).instance;
      instance.listeners.get("playing")?.();
      expect(onFirstFrame).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(320);
      expect(onFirstFrame).toHaveBeenCalledExactlyOnceWith("vid-1");
      expect(instance.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
      engine.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("创建一个官方 Player，并使用 playNext 切集", async () => {
    const instances: FakePlayer[] = [];
    class FakePlayer implements TikTokVePlayerInstance {
      static Events = {
        READY: "ready",
        LOAD_START: "first-frame",
        PLAYING: "playing",
        TIME_UPDATE: "timeupdate",
      };
      readonly listeners = new Map<string, (payload?: unknown) => void>();
      readonly player = {
        currentTime: 0,
        duration: 60,
        paused: true,
        ended: false,
        playbackRate: 1,
        play: vi.fn(async () => undefined),
        pause: vi.fn(),
        seek: vi.fn(),
      };
      readonly playNext = vi.fn(async (_options: TikTokVePlayerOptions) => undefined);
      readonly destroy = vi.fn();

      constructor(readonly options: TikTokVePlayerOptions) {
        instances.push(this);
      }

      on(event: string, listener: (payload?: unknown) => void): void {
        this.listeners.set(event, listener);
      }

      off(event: string): void {
        this.listeners.delete(event);
      }
    }
    const adapter = { getConstructor: vi.fn(async () => FakePlayer) };
    const onFirstFrame = vi.fn();
    const onBufferingChange = vi.fn();
    const engine = new TikTokMinisPlayerEngine(adapter,);

    await expect(engine.mount(document.createElement("div"), source(), { onFirstFrame, onBufferingChange })).resolves.toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0].options).toMatchObject({
      albumId: "album-1",
      episodeId: "episode-platform-1",
      vid: "vid-1",
      getVideoByToken: { needPoster: true },
    });
    engine.setPlaybackRate(1.5);
    expect(instances[0].player.playbackRate).toBe(1.5);

    instances[0].listeners.get("timeupdate")?.();
    expect(onFirstFrame).not.toHaveBeenCalled();
    instances[0].player.currentTime = 10;
    instances[0].listeners.get("timeupdate")?.();
    expect(onFirstFrame).not.toHaveBeenCalled();
    instances[0].player.paused = false;
    instances[0].player.currentTime = 0.1;
    instances[0].listeners.get("playing")?.();
    instances[0].listeners.get("timeupdate")?.();
    expect(onFirstFrame).toHaveBeenCalledWith("vid-1");
    vi.useFakeTimers();
    instances[0].listeners.get("waiting")?.();
    expect(onBufferingChange).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(180);
    expect(onBufferingChange).toHaveBeenLastCalledWith(true);
    instances[0].listeners.get("playing")?.();
    expect(onBufferingChange).toHaveBeenLastCalledWith(true);
    instances[0].listeners.get("timeupdate")?.();
    expect(onBufferingChange).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
    instances[0].player.paused = true;
    instances[0].player.currentTime = 0;
    instances[0].listeners.get("first-frame")?.();
    expect(onFirstFrame).toHaveBeenCalledOnce();

    await engine.switchSource(source({
      episodeId: "episode-platform-2",
      vid: "vid-2",
    }));
    expect(instances[0].playNext).toHaveBeenCalledWith(expect.objectContaining({
      albumId: "album-1",
      episodeId: "episode-platform-2",
      vid: "vid-2",
      getVideoByToken: { needPoster: true },
    }));
    expect(instances[0].player.pause).not.toHaveBeenCalled();
  });
});

it("实际帧回调未到前不报告出画，销毁后忽略迟到帧", async () => {
  const listeners = new Map<string, (data?: unknown) => void>();
  let frame!: VideoFrameRequestCallback;
  const cancel = vi.fn();
  class Player {
    player = { play: vi.fn(), pause: vi.fn(), video: { requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => { frame = callback; return 1; }, cancelVideoFrameCallback: cancel } as unknown as HTMLVideoElement };
    on(event: string, callback: (data?: unknown) => void) { listeners.set(event, callback); }
    off() {}
    playNext = vi.fn(async () => {});
    destroy = vi.fn();
  }
  const engine = new TikTokMinisPlayerEngine({ getConstructor: async () => Player });
  const firstFrame = vi.fn();
  await engine.mount(document.createElement("div"), source(), { onFirstFrame: firstFrame });
  listeners.get("playing")?.();
  expect(firstFrame).not.toHaveBeenCalled();
  engine.destroy();
  frame(0, {} as VideoFrameCallbackMetadata);
  expect(firstFrame).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith(1);
});
