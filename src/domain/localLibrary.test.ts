import { describe, expect, it, vi } from "vitest";

import { LocalLibraryStore } from "./localLibrary";
import type { DramaSummary } from "./types";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("LocalLibraryStore", () => {
  it("读写成功的快照在后续读故障时保留，故障期间修改不覆盖磁盘未知数据", () => {
    const storage = createStorage();
    const library = new LocalLibraryStore("app-a", "viewer-a", storage);
    library.setFollow("known", true);
    const read = vi.spyOn(storage, "getItem").mockImplementation(() => { throw new Error("Storage blocked token=secret"); });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(library.isFollowing("known")).toBe(true);
      library.setFollow("new", true);
      expect(library.follows()).toHaveLength(2);
      expect(JSON.stringify(log.mock.calls)).toContain("Storage blocked");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
      read.mockRestore();
      expect(library.follows()).toHaveLength(2);
      expect(new LocalLibraryStore("app-a", "viewer-a", storage).follows()).toHaveLength(1);
    } finally { read.mockRestore(); log.mockRestore(); }
  });
  it("每部剧只保留最近观看的一集，回看前集会替换旧分集并置顶", () => {
    const storage = createStorage();
    let time = Date.parse("2026-09-16T00:00:00Z");
    const library = new LocalLibraryStore("app-a", "viewer-a", storage, () => new Date(time++));
    const dramas = ["drama-1", "drama-2"].map(id => ({ id, title: id }) as DramaSummary);
    const record = (dramaId: string, episodeNumber: number, progressSeconds: number) => library.recordProgress({
      dramaId, episodeId: `${dramaId}-ep-${episodeNumber}`, episodeNumber, progressSeconds, durationSeconds: 60,
    });
    record("drama-1", 1, 10);
    record("drama-1", 3, 30);
    record("drama-2", 2, 20);
    expect(library.continueWatching(dramas).map(item => [item.drama.id, item.episodeNumber])).toEqual([["drama-2", 2], ["drama-1", 3]]);
    record("drama-1", 1, 25);
    const reloaded = new LocalLibraryStore("app-a", "viewer-a", storage);
    expect(reloaded.continueWatching(dramas).map(item => [item.drama.id, item.episodeNumber, item.progressSeconds])).toEqual([["drama-1", 1, 25], ["drama-2", 2, 20]]);
    expect(reloaded.history()).toHaveLength(2);
    expect(reloaded.history().find(item => item.dramaId === "drama-1")).toMatchObject({ episodeId: "drama-1-ep-1", progressSeconds: 25 });
    // 读取聚合列表不再迁移已按剧唯一保存的快照。
    expect(new LocalLibraryStore("app-a", "viewer-a", storage).history()).toEqual(reloaded.history());
  });

  it("旧快照按观看时间聚合，过滤目录外剧目，相同时间保留记录顺序", () => {
    const storage = createStorage();
    const history = [
      { dramaId: "1", episodeId: "older", updatedAt: "2026-09-16T00:00:00Z" },
      { dramaId: "missing", episodeId: "hidden", updatedAt: "2026-09-16T00:04:00Z" },
      { dramaId: "1", episodeId: "latest", updatedAt: "2026-09-16T00:03:00Z" },
      { dramaId: "1", episodeId: "same-time", updatedAt: "2026-09-16T00:03:00Z" },
      { dramaId: "2", episodeId: "second", updatedAt: "2026-09-16T00:02:00Z" },
    ].map(item => ({ ...item, episodeNumber: 1, progressSeconds: 20, durationSeconds: 60 }));
    storage.setItem('drama.local-library.v2:["app-a","viewer-a"]', JSON.stringify({ follows: [], history }));
    const library = new LocalLibraryStore("app-a", "viewer-a", storage);
    const dramas = ["1", "2"].map(id => ({ id }) as DramaSummary);
    expect(library.continueWatching(dramas).map(item => item.episodeId)).toEqual(["latest", "second"]);
    expect(library.history()).toEqual(history);
    expect(library.continueWatching([])).toEqual([]);
  });

  it("isolates follows and history by app code", () => {
    const storage = createStorage();
    const appA = new LocalLibraryStore("app-a", "viewer-a", storage, () => new Date("2026-07-28T00:00:00Z"));
    const appB = new LocalLibraryStore("app-b", "viewer-a", storage, () => new Date("2026-07-28T00:00:00Z"));

    appA.setFollow("drama-1", true);
    appA.recordProgress({
      dramaId: "drama-1",
      episodeId: "episode-1",
      episodeNumber: 1,
      progressSeconds: 24,
      durationSeconds: 60,
    });

    expect(appA.follows()).toEqual([{ dramaId: "drama-1", createdAt: "2026-07-28T00:00:00.000Z" }]);
    expect(appB.follows()).toEqual([]);
    expect(appB.history()).toEqual([]);
  });

  it("同应用不同观众的收藏和历史隔离，重新创建后恢复原观众的本地进度", () => {
    const storage = createStorage();
    const viewerA = new LocalLibraryStore("app-a", "viewer-a", storage);
    viewerA.setFollow("drama-1", true);
    viewerA.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 24, durationSeconds: 60 });
    const viewerB = new LocalLibraryStore("app-a", "viewer-b", storage);
    expect(viewerB.follows()).toEqual([]);
    expect(viewerB.history()).toEqual([]);
    viewerB.setFollow("drama-2", true);

    const reloadedA = new LocalLibraryStore("app-a", "viewer-a", storage);
    expect(reloadedA.isFollowing("drama-1")).toBe(true);
    expect(reloadedA.isFollowing("drama-2")).toBe(false);
    expect(reloadedA.history()).toEqual([expect.objectContaining({ episodeId: "episode-1", progressSeconds: 24 })]);
    // 旧页面在账号切换后同步 flush，仍只写冻结的原观众分区。
    viewerA.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 27, durationSeconds: 60 });
    expect(reloadedA.history()[0].progressSeconds).toBe(27);
    expect(viewerB.history()).toEqual([]);
  });

  it("把旧观众分区合并到无需登录的应用设备分区，并保留较新的记录", () => {
    const storage = createStorage();
    const legacy = new LocalLibraryStore("app-a", "viewer-a", storage, () => new Date("2026-07-28T00:00:00Z"));
    const local = new LocalLibraryStore("app-a", "local-device", storage, () => new Date("2026-07-28T00:01:00Z"));
    legacy.setFollow("drama-1", true);
    legacy.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 24, durationSeconds: 60 });
    local.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 30, durationSeconds: 60 });

    local.mergeFrom(legacy);
    local.mergeFrom(legacy);

    expect(local.follows()).toEqual([expect.objectContaining({ dramaId: "drama-1" })]);
    expect(local.history()).toEqual([expect.objectContaining({ dramaId: "drama-1", progressSeconds: 30 })]);
  });

  it("本地快照仅保存展示所需字段，不存播放器元数据、权益或凭据", () => {
    const storage = createStorage();
    const library = new LocalLibraryStore("app-a", "viewer-a", storage);
    library.setFollow("drama-1", true);
    library.recordProgress({ dramaId: "drama-1", episodeId: "episode-1", episodeNumber: 1, progressSeconds: 24, durationSeconds: 60, posterUrl: "https://images.example/episode-1.jpg" });
    const persisted = JSON.parse(storage.getItem('drama.local-library.v2:["app-a","viewer-a"]')!);
    expect(Object.keys(persisted)).toEqual(["follows", "history"]);
    expect(Object.keys(persisted.follows[0])).toEqual(["dramaId", "createdAt"]);
    expect(Object.keys(persisted.history[0])).toEqual(["dramaId", "episodeId", "episodeNumber", "progressSeconds", "durationSeconds", "updatedAt", "posterUrl"]);
    expect(persisted.history[0].posterUrl).toBe("https://images.example/episode-1.jpg");
  });

  it("replaces duplicate episode progress and keeps the newest item first", () => {
    const storage = createStorage();
    let now = new Date("2026-07-28T00:00:00Z");
    const library = new LocalLibraryStore("app-a", "viewer-a", storage, () => now);

    library.recordProgress({
      dramaId: "drama-1",
      episodeId: "episode-1",
      episodeNumber: 1,
      progressSeconds: 10,
      durationSeconds: 60,
    });
    now = new Date("2026-07-28T00:01:00Z");
    library.recordProgress({
      dramaId: "drama-2",
      episodeId: "episode-2",
      episodeNumber: 2,
      progressSeconds: 20,
      durationSeconds: 70,
    });
    now = new Date("2026-07-28T00:02:00Z");
    library.recordProgress({
      dramaId: "drama-1",
      episodeId: "episode-1",
      episodeNumber: 1,
      progressSeconds: 30,
      durationSeconds: 60,
    });

    expect(library.history()).toEqual([
      {
        dramaId: "drama-1",
        episodeId: "episode-1",
        episodeNumber: 1,
        progressSeconds: 30,
        durationSeconds: 60,
        updatedAt: "2026-07-28T00:02:00.000Z",
      },
      {
        dramaId: "drama-2",
        episodeId: "episode-2",
        episodeNumber: 2,
        progressSeconds: 20,
        durationSeconds: 70,
        updatedAt: "2026-07-28T00:01:00.000Z",
      },
    ]);
  });

  it("keeps local-library updates for the current page when storage writes fail", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage quota exceeded");
      },
    };
    const library = new LocalLibraryStore("app-a", "viewer-a", storage, () => new Date("2026-07-28T00:00:00Z"));

    library.setFollow("drama-1", true);
    library.recordProgress({
      dramaId: "drama-1",
      episodeId: "episode-1",
      episodeNumber: 1,
      progressSeconds: 20,
      durationSeconds: 60,
    });

    expect(library.follows()).toHaveLength(1);
    expect(library.history()).toHaveLength(1);
  });
});

it("历史摘要只持久化白名单字段，更新摘要不覆盖新进度或观看时间", () => {
  const storage = createStorage();
  const library = new LocalLibraryStore("app", "A", storage);
  const drama = { id: "1", firstEpisodeId: "11", title: "旧标题", description: "", coverUrl: "", tags: ["Drama"], episodeCount: 3, status: "completed" as const, episodes: [{ vid: "private-media" }], visitorToken: "private-credential" };
  library.recordProgress({ dramaId: "1", episodeId: "11", episodeNumber: 1, progressSeconds: 10, durationSeconds: 60, drama });
  library.recordProgress({ dramaId: "1", episodeId: "11", episodeNumber: 1, progressSeconds: 20, durationSeconds: 60 });
  const before = library.history()[0];
  library.updateHistorySummary({ ...drama, title: "新标题" });
  const reloaded = new LocalLibraryStore("app", "A", storage);
  expect(reloaded.continueWatching()[0].drama.title).toBe("新标题");
  expect(reloaded.history()[0]).toMatchObject({ progressSeconds: 20, updatedAt: before.updatedAt });
  expect(storage.getItem('drama.local-library.v2:["app","A"]')).not.toContain("private-");
  const copy = reloaded.history(); copy[0].drama!.tags.push("mutation");
  expect(reloaded.history()[0].drama!.tags).toEqual(["Drama"]);
});
