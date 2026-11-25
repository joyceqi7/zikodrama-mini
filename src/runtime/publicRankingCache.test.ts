import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DramaSummary, HomeRankingPage } from "../domain/types";
import { createPublicRankingCache } from "./publicHomeCache";

const categories = [{ tagId: "21", name: "Mystery" }, { tagId: "22", name: "Romance" }];
const drama: DramaSummary = { id: "1", firstEpisodeId: "2", title: "Public", description: "", coverUrl: "", tags: [], episodeCount: 1, status: "completed" };
const page = (tagId = "21"): HomeRankingPage => ({ tagId, name: "Mystery", dramas: [drama], nextCursor: "next" });
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), key: (index: number) => [...entries.keys()][index] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("分类目录不预取任何剧目，当前分类首屏去重并按分类、应用和接口环境隔离", async () => {
  const load = vi.fn(async (tagId: string) => page(tagId));
  const make = (app = "101", env = "https://api.test") => createPublicRankingCache(app, env, async () => categories, load);
  const cache = make();
  await cache.categories.load();
  expect(load).not.toHaveBeenCalled();
  await Promise.all([cache.load("21"), cache.load("21")]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.snapshot("22")).toBeUndefined();
  expect(make().snapshot("21")).toEqual(page());
  expect(make("102").snapshot("21")).toBeUndefined();
  expect(make("101", "https://other.test").snapshot("21")).toBeUndefined();
  await cache.load("22");
  expect(load).toHaveBeenCalledTimes(2);
});

it("首屏持久化保留完整二十条与游标，只保存公开字段，后续页不会覆盖首屏", async () => {
  const first = { ...page(), dramas: Array.from({ length: 20 }, (_, index) => ({ ...drama, id: String(index), visitorToken: "private-token", playback: { vid: "private-vid" } })) };
  const load = vi.fn(async (): Promise<HomeRankingPage> => first).mockResolvedValueOnce(first).mockResolvedValueOnce({ ...page(), dramas: [{ ...drama, id: "last" }], nextCursor: undefined });
  const make = () => createPublicRankingCache("101", "https://api.test", async () => categories, load);
  const cache = make();
  await cache.load("21");
  await cache.load("21", { cursor: "next", limit: 20 });
  const recovered = make().snapshot("21")!;
  expect(recovered.dramas).toHaveLength(20);
  expect(recovered.dramas[19].id).toBe("19");
  expect(recovered.nextCursor).toBe("next");
  expect(localStorage.getItem(localStorage.key(0)!)).not.toMatch(/private-token|private-vid|visitorToken|playback/);
});

it("审核修订变化时清除首屏并拒绝旧分类分页响应", async () => {
  let scope = "revision-1";
  let finish!: (value: HomeRankingPage) => void;
  const load = vi.fn(async () => page());
  const cache = createPublicRankingCache("101", "https://api.test", async () => categories, load, { prepare: async () => {}, scope: () => scope });
  await cache.load("21");
  load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const next = cache.load("21", { cursor: "next", limit: 20 });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  scope = "revision-2";
  finish(page());
  await expect(next).rejects.toThrow("Homepage configuration changed");
  expect(cache.snapshot("21")).toBeUndefined();
  await cache.load("21");
  expect(cache.snapshot("21")).toEqual(page());
});
