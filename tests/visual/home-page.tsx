/** 首页视觉与交互验证入口；测试替身仅在 tests 中使用，不接入正式构建或官方播放器。 */
import { createPublicHomeCache } from "../../src/runtime/publicHomeCache";
import { createRoot } from "react-dom/client";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import { HomePage } from "../../src/pages/HomePage";
import { App } from "../../src/App";
import { RuntimeContext } from "../../src/runtime/RuntimeContext";
import type { Runtime } from "../../src/runtime/runtime";
import type { AdExperience, DramaSummary, DiscoveryQuery } from "../../src/domain/types";
import "../../src/styles.css";
import "../../src/official-ui.css";
import "../../src/account-ui.css";
import "../../src/home-ui.css";

const params = new URLSearchParams(window.location.search);
const state = params.get("state");
const cacheMode = state === "cache";
let finishLogin!: () => void;
let finishData!: () => void;
const loginPending = new Promise<void>(resolve => { finishLogin = resolve; });
const dataPending = new Promise<void>(resolve => { finishData = resolve; });
// 只生成确定性测试封面，避免将示例推荐或媒体地址注入产品运行时。
const titles = ["Ranch of Secret Longings", "The Heir's Scandal Boy", "Forbidden Heir", "The Devilish Lord and His Lamb Nun"];
const colors = ["#6b4834", "#334f65", "#51443d", "#5c3836"];
const descriptions = [
  "A ranch owner discovers that the stranger she trusts is hiding a dangerous secret.",
  "A hidden heir turns a public scandal into an unexpected romance.",
  "A forbidden inheritance forces two rivals to face an old betrayal.",
  "A powerful lord risks everything for the one person he cannot protect.",
];
const dramas: DramaSummary[] = titles.map((title, index) => ({
  id: `visual-${index}`, firstEpisodeId: `episode-${index}`, title,
  coverUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="${colors[index]}"/><circle cx="180" cy="175" r="118" fill="#ffffff" opacity=".08"/><path d="M0 480L180 220L360 480" fill="#000000" opacity=".2"/><text x="180" y="170" text-anchor="middle" fill="#ead8c0" font-size="88" font-family="serif">${index + 1}</text></svg>`)}`,
  description: descriptions[index], tags: [index % 2 ? "Romance" : "Mystery"], episodeCount: 24, status: index % 2 ? "ongoing" : "completed",
}));
let attempts = 0;
const saved = new Set<string>();
const loadFixtureSections = async () => {
  if (state === "startup") await dataPending;
  if (state === "error" && attempts++ === 0) throw new Error("Visual fixture recommendations unavailable");
  if (state === "empty") return { carousel: [], hot: [], rankings: [] };
  const carouselCount = state === "single" ? 1 : state === "pair" ? 2 : state === "triple" ? 3 : dramas.length;
  return { carousel: dramas.slice(0, carouselCount), hot: dramas, rankings: [
    { tagId: "21", name: "Mystery", dramas: [dramas[2], dramas[0]] },
    { tagId: "22", name: "Romance", dramas: [dramas[3], dramas[1]] },
  ] };
};
const visualAdExperience: AdExperience = {
  vipState: { active: false, adCount: 0, requiredCount: 5, progressDate: "2026-09-30" },
  monetizationPolicy: { status: "enabled", strategy: "rules", freeEpisodeCount: 1,
    episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
    vip: { enabled: true, requiredAdCount: 5, title: "", content: "" } },
  vipOffer: { offerId: "visual-vip", adUnitId: "visual-ad", kind: "rewarded_vip" },
};
const runtime = {
  getApplicationBrand: () => ({ name: "Plotimo", logoUrl: "" }),
  getAdExperience: () => visualAdExperience,
  subscribeAdExperience: () => () => undefined,
  watchVIPAd: async () => null,
  loadHomeCarousel: async () => (await loadFixtureSections()).carousel,
  loadHomeHot: async () => (await loadFixtureSections()).hot,
  loadHomeRankings: async () => (await loadFixtureSections()).rankings,
  api: { discover: async (input: DiscoveryQuery) => ({
    items: dramas.filter(drama => (!input.query || drama.title.toLowerCase().includes(input.query.toLowerCase())) && (!input.tag || drama.tags.includes(input.tag))),
    tags: ["Mystery", "Romance"],
  }) },
  localLibrary: { history: () => [], follows: () => [], continueWatching: () => [], setFollow: (id: string, follow: boolean) => { if (follow) saved.add(id); else saved.delete(id); } },
} as unknown as Runtime;
if (state === "paged") {
  // 真实首页组件的分类分页验收：测试数据只在该入口生成，生产构建不包含此替身。
  runtime.loadHomeRankingCategories = async () => [{ tagId: "21", name: "Mystery" }, { tagId: "22", name: "Romance" }];
  runtime.loadHomeRankingPage = async (tagId, input = {}) => {
    console.info("ranking_fixture_request", { tagId, cursor: input.cursor ?? "first" });
    const offset = Number(input.cursor ?? 0);
    const total = tagId === "21" ? 45 : 25;
    const end = Math.min(total, offset + (input.limit ?? 20));
    return { tagId, name: tagId === "21" ? "Mystery" : "Romance", dramas: Array.from({ length: end - offset }, (_, index) => ({
      ...dramas[index % dramas.length], id: `${tagId}-${offset + index}`, title: `${tagId === "21" ? "Mystery" : "Romance"} Drama ${offset + index + 1}`,
    })), nextCursor: end < total ? String(end) : undefined };
  };
}
if (cacheMode) {
  const revised = params.get("revised") === "1";
  const catalog = Array.from({ length: 12 }, (_, index) => ({ ...dramas[index % 4], id: `catalog-${index}`, title: `Catalog ${index + 1}` }));
  const loadCarousel = runtime.loadHomeCarousel!;
  const loadHot = runtime.loadHomeHot!;
  const loadRankings = runtime.loadHomeRankings!;
  const cache = createPublicHomeCache(
    "visual-startup", "test-fixture",
    async () => { await dataPending; const value = await loadCarousel(); return revised ? [...value].reverse() : value; },
    async () => { await dataPending; return loadHot(); },
    async () => { await dataPending; return revised ? [] : loadRankings(); },
    async () => {
      await dataPending;
      return { dramas: revised ? [{ ...catalog[0], id: "new-drama", title: "New drama" }, ...catalog.slice(0, 11)] : catalog };
    },
  );
  runtime.getCachedHomeCarousel = cache.carousel.snapshot;
  runtime.getCachedHomeHot = cache.hot.snapshot;
  runtime.getCachedHomeRankings = cache.rankings.snapshot;
  runtime.getCachedPublicCatalog = cache.catalog.snapshot;
  runtime.loadHomeCarousel = cache.carousel.load;
  runtime.loadHomeHot = cache.hot.load;
  runtime.loadHomeRankings = cache.rankings.load;
  runtime.loadPublicCatalog = cache.catalog.load;
}
if (state === "startup" || cacheMode) {
  runtime.bootstrap = () => loginPending;
  if (!cacheMode) runtime.loadPublicCatalog = async () => { await dataPending; return { dramas }; };
  runtime.getLaunchTarget = () => undefined;
  runtime.subscribeAdExperience = () => () => {};
}
// 保留手机底部安全区，不绘制系统状态栏和 TikTok 胶囊。
document.documentElement.style.setProperty("--minis-bottom", "34px");
createRoot(document.getElementById("root")!).render(state === "startup" || cacheMode ? <>
  <aside aria-label="启动测试控制" style={{ position: "fixed", bottom: 0, right: 0, zIndex: 20, background: "#333" }}>
    <button type="button" onClick={finishLogin}>完成测试登录</button>
    <button type="button" onClick={finishData}>返回测试数据</button>
    {cacheMode && <button type="button" onClick={() => document.querySelector('[data-home-anchor="drama-catalog-4"]')?.scrollIntoView({ block: "start" })}>查看目录</button>}
  </aside>
  <App runtime={runtime} />
</> : <RuntimeContext.Provider value={runtime}><HashRouter><Routes>
  <Route path="/" element={<HomePage />} />
  <Route path="/watch/:dramaId/:episodeId" element={<main><h1>Playback route</h1><Link to="/">Back to Home</Link></main>} />
</Routes></HashRouter></RuntimeContext.Provider>);
