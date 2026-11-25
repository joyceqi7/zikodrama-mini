import { afterEach, expect, it, vi } from "vitest";
import { HttpMiniDramaApi } from "./httpMiniDramaApi";

afterEach(() => vi.restoreAllMocks());
const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

it("分类目录和单分类分页使用公开接口，不携带访客凭据，也不请求完整分类榜", async () => {
  const categories = [{ tagId: "21", name: "Mystery" }];
  const page = { ...categories[0], dramas: [], nextCursor: "next" };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(categories)).mockResolvedValueOnce(response(page));
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  await expect(api.homeRankingCategories("101")).resolves.toEqual(categories);
  await expect(api.homeRankingPage("101", "21", { cursor: "v1:20", limit: 20 })).resolves.toEqual(page);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://api.example.test/api/v1/open/home/ranking-categories?tiktokAppId=101",
    "https://api.example.test/api/v1/open/home/rankings/21?tiktokAppId=101&limit=20&cursor=v1%3A20",
  ]);
  for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).has("authorization")).toBe(false);
});

it("拒绝错误分类、超出页大小、损坏游标和不前进的游标，诊断不输出响应全文", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = { tagId: "21", name: "Mystery", dramas: [] };
  const fetcher = vi.fn<typeof fetch>();
  const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
  for (const data of [null, { ...page, tagId: "22" }, { ...page, dramas: null }, { ...page, dramas: Array(21).fill({}) }, { ...page, nextCursor: 42 }, { ...page, nextCursor: "same" }]) {
    fetcher.mockResolvedValueOnce(response({ ...data, visitorToken: "private-marker" }));
    await expect(api.homeRankingPage("101", "21", { cursor: "same" })).rejects.toMatchObject({ code: "invalid_response" });
  }
  fetcher.mockResolvedValueOnce(response([{ tagId: 21, name: "Mystery" }]));
  await expect(api.homeRankingCategories("101")).rejects.toMatchObject({ code: "invalid_response" });
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-marker");
});
