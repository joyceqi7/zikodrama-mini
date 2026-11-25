import { describe, expect, it } from "vitest";
import { playbackEntryPath } from "./resumePlayback";
import type { DramaSummary } from "./types";

const drama: DramaSummary = {
  id: "drama-1",
  firstEpisodeId: "episode-1",
  firstEpisodePosterUrl: "https://images.example/first frame.jpg",
  title: "Drama",
  description: "",
  coverUrl: "https://images.example/cover.jpg",
  episodeCount: 3,
  tags: [],
  status: "ongoing",
};

describe("playbackEntryPath", () => {
  it("无历史时进入首集并携带编码后的首帧图", () => {
    expect(playbackEntryPath([], drama)).toBe(
      "/watch/drama-1/episode-1?firstEpisodePosterUrl=https%3A%2F%2Fimages.example%2Ffirst%20frame.jpg",
    );
  });

  it("有历史时直接进入缓存分集且不携带图片参数", () => {
    expect(playbackEntryPath([{
      dramaId: "drama-1",
      episodeId: "episode-3",
      episodeNumber: 3,
      progressSeconds: 24,
      durationSeconds: 60,
      posterUrl: "https://images.example/episode-3.jpg",
      updatedAt: "2026-09-23T00:00:00.000Z",
    }], drama)).toBe("/watch/drama-1/episode-3");
  });
});
