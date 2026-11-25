import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DramaSummary, HomeRankingPage } from "../domain/types";
import { RuntimeContext } from "../runtime/RuntimeContext";
import type { Runtime } from "../runtime/runtime";
import { HomeCategoryRankings } from "./HomeCategoryRankings";

const lifecycle = vi.hoisted(() => ({ refresh: () => {} }));
vi.mock("./useForegroundRefresh", () => ({ useForegroundRefresh: (_runtime: unknown, refresh: () => void) => { lifecycle.refresh = refresh; } }));
const categories = [{ tagId: "21", name: "Mystery" }, { tagId: "22", name: "Romance" }];
const drama = (id: string): DramaSummary => ({ id, title: id, firstEpisodeId: "1", description: "", coverUrl: "", tags: [], status: "completed", episodeCount: 1 });
const page = (tagId = "21", ids = ["first"], nextCursor?: string): HomeRankingPage => ({ tagId, name: categories.find(item => item.tagId === tagId)!.name, dramas: ids.map(drama), nextCursor });
const observers = new Set<IntersectionObserverCallback>();
beforeEach(() => {
  observers.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(selectedCategory?: string) {
  const loadHomeRankingCategories = vi.fn(async () => categories);
  const loadHomeRankingPage = vi.fn(async (tagId: string) => page(tagId, [tagId === "21" ? "first" : "other"], "next"));
  const runtime = { loadHomeRankingCategories, loadHomeRankingPage } as unknown as Runtime;
  const onCategoryChange = vi.fn();
  render(<RuntimeContext.Provider value={runtime}><HomeCategoryRankings selectedCategory={selectedCategory} onCategoryChange={onCategoryChange} renderDrama={drama => <span>{drama.title}</span>} /></RuntimeContext.Provider>);
  return { runtime, loadHomeRankingCategories, loadHomeRankingPage, onCategoryChange };
}
const intersect = () => act(() => observers.forEach(callback => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

it("首页只请求默认分类，切换后再请求对应分类，失效选择回到默认分类", async () => {
  const { loadHomeRankingPage, onCategoryChange } = setup("missing");
  await screen.findByText("first");
  expect(loadHomeRankingPage.mock.calls).toEqual([["21", { limit: 20 }]]);
  fireEvent.click(screen.getByRole("button", { name: "Romance" }));
  // 外部受控选择由父组件更新，本用例验证请求触发前先通知父组件。
  expect(onCategoryChange).toHaveBeenCalledWith("22");
});

it("分类按钮按需请求，不显示上一分类的卡片", async () => {
  const { loadHomeRankingPage } = setup();
  await screen.findByText("first");
  fireEvent.click(screen.getByRole("button", { name: "Romance" }));
  await screen.findByText("other");
  expect(screen.queryByText("first")).not.toBeInTheDocument();
  expect(loadHomeRankingPage.mock.calls).toEqual([["21", { limit: 20 }], ["22", { limit: 20 }]]);
});

it("触底仅翻一页，连续通知去重，末页停止，跨页重复剧目只保留一次", async () => {
  const { loadHomeRankingPage } = setup();
  await screen.findByText("first");
  const next = deferred<HomeRankingPage>();
  loadHomeRankingPage.mockImplementationOnce(() => next.promise);
  intersect(); intersect();
  expect(loadHomeRankingPage).toHaveBeenCalledTimes(2);
  expect(loadHomeRankingPage).toHaveBeenLastCalledWith("21", { limit: 20, cursor: "next" });
  await act(async () => next.resolve(page("21", ["first", "second"])));
  expect(within(screen.getByRole("list", { name: "Mystery rankings" })).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  intersect();
  expect(loadHomeRankingPage).toHaveBeenCalledTimes(2);
});

it("快速切换时丢弃旧分类的首页和翻页响应", async () => {
  const { loadHomeRankingPage } = setup();
  await screen.findByText("first");
  const next = deferred<HomeRankingPage>();
  loadHomeRankingPage.mockImplementationOnce(() => next.promise);
  intersect();
  fireEvent.click(screen.getByRole("button", { name: "Romance" }));
  await screen.findByText("other");
  await act(async () => next.resolve(page("21", ["late-next"])));
  expect(screen.queryByText("late-next")).not.toBeInTheDocument();
  const oldFirst = deferred<HomeRankingPage>();
  loadHomeRankingPage.mockImplementationOnce(() => oldFirst.promise);
  fireEvent.click(screen.getByRole("button", { name: "Mystery" }));
  await waitFor(() => expect(loadHomeRankingPage).toHaveBeenCalledTimes(4));
  fireEvent.click(screen.getByRole("button", { name: "Romance" }));
  await screen.findByText("other");
  await act(async () => oldFirst.resolve(page("21", ["late-first"])));
  expect(screen.queryByText("late-first")).not.toBeInTheDocument();
});

it("翻页失败保留当前列表、记录脱敏日志并停止自动重试，点击重试可以恢复", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { loadHomeRankingPage } = setup();
  await screen.findByText("first");
  loadHomeRankingPage.mockRejectedValueOnce(new Error("network failed https://example.test/?token=private-token"));
  intersect();
  await screen.findByRole("button", { name: "Retry dramas" });
  expect(screen.getByText("first")).toBeInTheDocument();
  intersect(); intersect();
  expect(loadHomeRankingPage).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "home_ranking_more_failed", tagId: "21" }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
  expect(screen.queryByText(/network failed/)).not.toBeInTheDocument();
  loadHomeRankingPage.mockResolvedValueOnce(page("21", ["first", "recovered"]));
  fireEvent.click(screen.getByRole("button", { name: "Retry dramas" }));
  await screen.findByText("recovered");
  expect(loadHomeRankingPage).toHaveBeenLastCalledWith("21", { limit: 20, cursor: "next" });
});

it("回到前台刷新时保留已展开列表并恢复同一分类已加载页数", async () => {
  const { loadHomeRankingPage } = setup();
  await screen.findByText("first");
  loadHomeRankingPage.mockResolvedValueOnce(page("21", ["second"]));
  intersect();
  await screen.findByText("second");
  const refresh = deferred<HomeRankingPage>();
  loadHomeRankingPage.mockImplementationOnce(() => refresh.promise).mockResolvedValueOnce(page("21", ["new-second"]));
  act(() => lifecycle.refresh());
  expect(screen.getByText("second")).toBeInTheDocument();
  await act(async () => refresh.resolve(page("21", ["new-first"], "refreshed-next")));
  await screen.findByText("new-second");
  expect(loadHomeRankingPage).toHaveBeenLastCalledWith("21", { limit: 20, cursor: "refreshed-next" });
});

it("刷新已展开分类失败后重试仍恢复原页数，不把列表缩回第一页", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { loadHomeRankingPage } = setup();
  await screen.findByText("first");
  loadHomeRankingPage.mockResolvedValueOnce(page("21", ["second"]));
  intersect();
  await screen.findByText("second");
  loadHomeRankingPage.mockRejectedValueOnce(new Error("refresh offline"));
  act(() => lifecycle.refresh());
  await screen.findByRole("button", { name: "Retry dramas" });
  expect(screen.getByText("second")).toBeInTheDocument();
  loadHomeRankingPage.mockResolvedValueOnce(page("21", ["new-first"], "retry-next")).mockResolvedValueOnce(page("21", ["new-second"]));
  fireEvent.click(screen.getByRole("button", { name: "Retry dramas" }));
  await screen.findByText("new-second");
  expect(loadHomeRankingPage).toHaveBeenLastCalledWith("21", { limit: 20, cursor: "retry-next" });
});
