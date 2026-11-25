import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Runtime } from "../runtime/runtime";
import { PlaybackLaunchPreview } from "./PlaybackLaunchPreview";

afterEach(() => vi.restoreAllMocks());

it("缺少封面和错误时不渲染占位层，目标封面就绪后直接展示封面", () => {
  const runtime = {
    getCachedPublicCatalog: () => undefined,
    loadPlaybackCover: vi.fn(),
    localLibrary: { history: vi.fn(() => []) },
  } as unknown as Runtime;
  const view = render(<PlaybackLaunchPreview runtime={runtime} dramaId="" deferCoverLookup />);
  expect(view.container).toBeEmptyDOMElement();
  expect(runtime.loadPlaybackCover).not.toHaveBeenCalled();
  expect(runtime.localLibrary.history).not.toHaveBeenCalled();
  view.rerender(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode" coverUrl="/target.jpg" deferCoverLookup />);
  expect(view.container.querySelector("img")).toHaveAttribute("src", "/target.jpg");
  expect(view.getByRole("status")).toHaveAttribute("aria-busy", "true");
});

it("身份确认后才读取目标海报，切换目标后忽略迟到结果且全程不扫描目录", async () => {
  let finish!: (poster: string) => void;
  const runtime = {
    getCachedPublicCatalog: () => undefined,
    loadPublicCatalog: vi.fn(),
    loadPlaybackCover: vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce("https://images.example/current-episode.jpg"),
    localLibrary: { history: vi.fn(() => []) },
  } as unknown as Runtime;
  const view = render(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode-1" />);
  expect(runtime.loadPlaybackCover).not.toHaveBeenCalled();
  expect(runtime.localLibrary.history).not.toHaveBeenCalled();
  view.rerender(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode-1" identityReady />);
  expect(runtime.loadPlaybackCover).toHaveBeenCalledWith("drama", "episode-1");
  view.rerender(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode-2" identityReady />);
  await waitFor(() => expect(view.container.querySelector("img")).toHaveAttribute("src", "https://images.example/current-episode.jpg"));
  await act(async () => finish("https://images.example/old-episode.jpg"));
  expect(view.container.querySelector("img")).toHaveAttribute("src", "https://images.example/current-episode.jpg");
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
});

it("缓存封面加载失败先尝试原图，再移除坏图并记录不含媒体地址的原因", () => {
  const cover = "https://images.example/private-cover~tplv-vod-noop.image";
  const logging = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const runtime = {
    getCachedPublicCatalog: () => ({ dramas: [{ id: "drama", coverUrl: cover }] }),
    loadPublicCatalog: vi.fn(),
    localLibrary: { history: vi.fn(() => []) },
  } as unknown as Runtime;
  const view = render(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode" />);
  const image = view.container.querySelector("img")!;
  fireEvent.error(image);
  expect(image.getAttribute("src")).toBe(cover);
  expect(logging).toHaveBeenCalledWith({ event: "playback_launch_cover_image_failed", error: "Playback preview thumbnail failed; retrying original image" });
  fireEvent.error(image);
  expect(view.container).toBeEmptyDOMElement();
  expect(logging).toHaveBeenCalledWith({ event: "playback_launch_cover_image_failed", error: "Playback preview image failed to load" });
  expect(logging).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(logging.mock.calls)).not.toContain(cover);
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
  expect(runtime.localLibrary.history).not.toHaveBeenCalled();
});


it("身份就绪的重绘直接消费已有目标封面，关闭独立查图时仍连续交接且不扫描目录", () => {
  let confirmed = "";
  const runtime = {
    getCachedPlaybackCover: vi.fn((dramaId: string, episodeId: string) => dramaId === "drama" && episodeId === "episode-2" ? confirmed : ""),
    getCachedPublicCatalog: () => undefined,
    loadPlaybackCover: vi.fn(),
    loadPublicCatalog: vi.fn(),
    localLibrary: { history: vi.fn(() => []) },
  } as unknown as Runtime;
  const view = render(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode-2" deferCoverLookup />);
  expect(view.container.querySelector("img")).toBeNull();
  expect(runtime.localLibrary.history).not.toHaveBeenCalled();
  confirmed = "https://images.example/entry-poster~tplv-vod-noop.image";
  view.rerender(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode-2" deferCoverLookup identityReady />);
  expect(view.container.querySelector("img")).toHaveAttribute("src", "https://images.example/entry-poster~tplv-vod-rs:480:0.webp");
  view.rerender(<PlaybackLaunchPreview runtime={runtime} dramaId="drama" episodeId="episode-3" deferCoverLookup identityReady />);
  expect(view.container.querySelector("img")).toBeNull();
  expect(runtime.loadPlaybackCover).not.toHaveBeenCalled();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
});
