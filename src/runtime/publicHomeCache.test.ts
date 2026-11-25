import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPublicHomeCache } from "./publicHomeCache";
import type { CategoryRankingSection, DramaSummary, HomeSections } from "../domain/types";
const drama: DramaSummary = { id: "001", firstEpisodeId: "002", firstEpisodePosterUrl: "/first.jpg", title: "公开短剧", description: "", coverUrl: "/cover.jpg", episodeCount: 8, tags: ["Romance"], status: "completed" };
const sections = { carousel: [drama], hot: [drama], rankings: [{ tagId: "01", name: "Romance", dramas: [drama] }] };
const catalog = { dramas: [drama], nextCursor: "next", tags: ["Romance"] };
const make = (app = "001", api = "https://api.example", load: () => Promise<HomeSections> = vi.fn(async () => sections)) => createPublicHomeCache(
  app, api,
  async () => (await load()).carousel,
  async () => (await load()).hot,
  async () => (await load()).rankings ?? [],
  async () => catalog,
);
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    key: (index: number) => [...entries.keys()][index],
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("按应用和接口环境恢复首屏，磁盘命中仍刷新，同一启动只请求一次", async () => {
  const first = make();
  await Promise.all([first.sections.load(), first.catalog.load()]);
  const load = vi.fn(async () => sections);
  const second = make("001", "https://api.example", load);
  expect(second.sections.snapshot()).toEqual(sections);
  expect(second.catalog.snapshot()).toEqual(catalog);
  expect(make("002").sections.snapshot()).toBeUndefined();
  expect(make("001", "https://other.example").catalog.snapshot()).toBeUndefined();
  await Promise.all([second.sections.load(), second.sections.load()]);
  await second.sections.load();
  expect(load).toHaveBeenCalledTimes(3);
});
it("持久化只保留公开白名单，空结果覆盖已下线缓存", async () => {
  const unsafe = { ...sections, visitorToken: "secret-token", carousel: [{ ...drama, playback: { vid: "private-vid" }, accessMode: "unlocked" }] };
  await make("001", "https://api.example", vi.fn(async () => unsafe)).sections.load();
  const raw = localStorage.getItem(localStorage.key(0)!)!;
  expect(raw).not.toMatch(/secret-token|private-vid|accessMode|playback/);
  expect(make().sections.snapshot()?.carousel[0].id).toBe("001");
  await make("001", "https://api.example", vi.fn(async () => ({ carousel: [], hot: [] }))).sections.load();
  expect(make().sections.snapshot()?.carousel).toEqual([]);
});
it("离线保留缓存并传播失败，恢复后可重试", async () => {
  await make().sections.load();
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ carousel: [], hot: [] });
  const cache = make("001", "https://api.example", load);
  await expect(cache.sections.load()).rejects.toThrow("offline");
  expect(cache.sections.snapshot()?.carousel).toEqual(sections.carousel);
  expect(cache.sections.snapshot()?.hot).toEqual([]);
  await cache.sections.load();
  expect(cache.sections.snapshot()?.carousel).toEqual([]);
});
it("过期、损坏和存储拒绝不阻断真实数据，日志不泄露缓存内容", async () => {
  await make().sections.load();
  const key = localStorage.key(0)!;
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  expect(make().carousel.snapshot()).toBeUndefined();
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  localStorage.setItem(key, '{"visitorToken":"private-token"');
  expect(make().carousel.snapshot()).toBeUndefined();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "home_cache_read_failed", error: expect.any(String) }));
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
  expect(await make().sections.load()).toEqual(sections);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "home_cache_write_failed", error: "QuotaExceededError" }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
});

it("完整保存二十条首屏目录及其游标，重新启动不会跳过后八条", async () => {
  const logging = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const page = { dramas: Array.from({ length: 20 }, (_, index) => ({ ...drama, id: `900719925474${String(index).padStart(4, "0")}` })), nextCursor: "after-twenty", tags: ["Romance"] };
  const create = () => createPublicHomeCache("001", "https://api.example", async () => [], async () => [], async () => [], async () => page);
  await expect(create().catalog.load()).resolves.toEqual(page);
  expect(create().catalog.snapshot()).toEqual(page);
  expect(logging).not.toHaveBeenCalled();
});

it("真实规模的三十七个分类和大榜单可以落盘，恢复保留全部名次且只保存公开字段", async () => {
  const logging = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const full: CategoryRankingSection[] = Array.from({ length: 37 }, (_, category) => ({
    tagId: String(category + 1), name: `分类 ${category + 1}`,
    dramas: Array.from({ length: category === 0 ? 142 : 18 }, (_, index) => ({
      ...drama, id: String(category * 200 + index), description: "公开简介" + "x".repeat(600),
      visitorToken: "private-token", playback: { playAuthToken: "private-playback" },
    })),
  }));
  const create = () => createPublicHomeCache("001", "https://api.example", async () => [], async () => [], async () => full, async () => catalog);
  const cache = create();
  expect(await cache.rankings.load()).toEqual(full);
  const raw = localStorage.getItem(localStorage.key(0)!)!;
  expect(raw.length).toBeGreaterThan(256 * 1024);
  expect(raw).not.toMatch(/private-token|private-playback|visitorToken|playback/);
  const recovered = create().rankings.snapshot()!;
  expect(recovered.map(section => [section.tagId, section.dramas.map(item => item.id)])).toEqual(full.map(section => [section.tagId, section.dramas.map(item => item.id)]));
  expect(recovered[0].dramas[141].firstEpisodePosterUrl).toBe(drama.firstEpisodePosterUrl);
  expect(logging).not.toHaveBeenCalled();
});

it("超出单项存储预算仍返回完整网络数据，诊断不输出缓存内容", async () => {
  const logging = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const large = Array.from({ length: 1500 }, (_, index) => ({ ...drama, id: String(index), description: "private-cache-marker" + "x".repeat(1000) }));
  const cache = createPublicHomeCache("001", "https://api.example", async () => large, async () => [], async () => [], async () => catalog);
  await expect(cache.carousel.load()).resolves.toEqual(large);
  expect(cache.carousel.snapshot()).toEqual(large);
  expect(localStorage.getItem(localStorage.key(0)!)).toBeNull();
  expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "home_cache_write_failed", error: "Homepage cache exceeds size limit" }));
  expect(JSON.stringify(logging.mock.calls)).not.toContain("private-cache-marker");
});
