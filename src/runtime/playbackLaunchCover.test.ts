import { expect, it, vi } from "vitest";

import type { DramaSummary } from "../domain/types";
import type { Runtime } from "./runtime";
import { cachedPlaybackCover } from "./playbackLaunchCover";

const summary: DramaSummary = {
  id: "drama-1", firstEpisodeId: "episode-1", title: "测试短剧", description: "",
  coverUrl: "https://images.example/cover.jpg", episodeCount: 1, tags: [], status: "ongoing",
};

it("只采用目标剧目的公开封面，目录缺图时回退已缓存的首页区域", () => {
  const runtime = {
    getCachedPublicCatalog: () => ({ dramas: [{ ...summary, coverUrl: "" }] }),
    getCachedHomeSections: () => ({ carousel: [], hot: [summary], rankings: [] }),
  } as unknown as Runtime;

  expect(cachedPlaybackCover(runtime, "drama-1")).toBe(summary.coverUrl);
  expect(cachedPlaybackCover(runtime, "other-drama")).toBe("");
});

it("首集使用首帧图，续播其他集和旧摘要回退封面", () => {
  const runtime = { getCachedPublicCatalog: () => ({ dramas: [{ ...summary, firstEpisodePosterUrl: "/first.jpg" }] }) } as unknown as Runtime;
  expect(cachedPlaybackCover(runtime, "drama-1", "episode-1")).toBe("/first.jpg");
  expect(cachedPlaybackCover(runtime, "drama-1", "episode-2")).toBe(summary.coverUrl);
  expect(cachedPlaybackCover(runtime, "drama-1")).toBe(summary.coverUrl);
});


it("同一目标的已确认海报优先于公开首页，无确切分集或缓存未命中才沿用原回退", () => {
  const confirmed = "https://images.example/confirmed-episode.jpg";
  const runtime = {
    getCachedPlaybackCover: vi.fn((dramaId: string, episodeId: string) => dramaId === "drama-1" && episodeId === "episode-2" ? confirmed : ""),
    getCachedPublicCatalog: vi.fn(() => ({ dramas: [{ ...summary, firstEpisodePosterUrl: "/first.jpg" }] })),
    getCachedHomeSections: vi.fn(),
    loadPlaybackCover: vi.fn(),
    loadPublicCatalog: vi.fn(),
  } as unknown as Runtime;
  expect(cachedPlaybackCover(runtime, "drama-1", "episode-2")).toBe(confirmed);
  expect(runtime.getCachedPublicCatalog).not.toHaveBeenCalled();
  expect(runtime.getCachedHomeSections).not.toHaveBeenCalled();
  expect(cachedPlaybackCover(runtime, "drama-1", "episode-1")).toBe("/first.jpg");
  vi.mocked(runtime.getCachedPlaybackCover!).mockClear();
  expect(cachedPlaybackCover(runtime, "drama-1")).toBe(summary.coverUrl);
  expect(cachedPlaybackCover(runtime, "")).toBe("");
  expect(runtime.getCachedPlaybackCover).not.toHaveBeenCalled();
  expect(runtime.loadPlaybackCover).not.toHaveBeenCalled();
  expect(runtime.loadPublicCatalog).not.toHaveBeenCalled();
});
