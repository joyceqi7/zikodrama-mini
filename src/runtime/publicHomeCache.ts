import type { CategoryRankingSection, DiscoveryQuery, DramaSummary, HomePayload, HomeRankingCategory, HomeRankingPage, HomeSections } from "../domain/types";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

const MAX_AGE = 24 * 60 * 60 * 1000;
// 单项缓存保留一 MiB 上限，覆盖完整分类榜；内容超限仍只影响落盘，不截断线上结果。
const MAX_BYTES = 1024 * 1024;
function exceedsCacheBudget(raw: string): boolean {
  return raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid homepage cache object");
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid homepage cache text");
  return value;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid homepage cache tags");
  return value.map(string);
};
function dramas(value: unknown, limit?: number): DramaSummary[] {
  // 推荐与榜单没有五十条的接口上限，按完整摘要校验并由序列化预算限制存储；目录单独约束页大小。
  if (!Array.isArray(value) || (limit !== undefined && value.length > limit)) throw new Error("Invalid homepage cache dramas");
  return value.map(item => {
    const d = object(item);
    if (d.status !== "ongoing" && d.status !== "completed") throw new Error("Invalid homepage cache drama status");
    if (typeof d.episodeCount !== "number" || !Number.isSafeInteger(d.episodeCount) || d.episodeCount < 0) throw new Error("Invalid homepage cache episode count");
    // 明确列举公开展示字段，丢弃意外夹带的身份、权益、播放源和奖励数据。
    return { id: string(d.id), firstEpisodeId: string(d.firstEpisodeId), title: string(d.title), description: string(d.description),
      ...(d.firstEpisodePosterUrl === undefined ? {} : { firstEpisodePosterUrl: string(d.firstEpisodePosterUrl) }),
      coverUrl: string(d.coverUrl), episodeCount: d.episodeCount, tags: strings(d.tags), status: d.status };
  });
}
function sections(value: unknown): HomeSections {
  const data = object(value);
  const rankings = data.rankings;
  if (rankings !== undefined && (!Array.isArray(rankings) || rankings.length > 50)) throw new Error("Invalid homepage cache rankings");
  return { carousel: dramas(data.carousel), hot: dramas(data.hot), rankings: (rankings as unknown[] | undefined)?.map(item => {
    const ranking = object(item);
    return { tagId: string(ranking.tagId), name: string(ranking.name), dramas: dramas(ranking.dramas) };
  }) };
}

function rankings(value: unknown): CategoryRankingSection[] {
  const normalized = sections({ carousel: [], hot: [], rankings: value }).rankings;
  return normalized ?? [];
}
function catalog(value: unknown): HomePayload {
  const data = object(value);
  return { dramas: dramas(data.dramas, 20), tags: data.tags === undefined ? undefined : strings(data.tags),
    nextCursor: data.nextCursor === undefined ? undefined : string(data.nextCursor) };
}

function resource<T>(key: string, normalize: (value: unknown) => T, request: () => Promise<T>, options?: HomeCacheOptions) {
  let snapshot: T | undefined;
  let pending: Promise<T> | undefined;
  let refreshedAt: number | undefined;
  let storageKey: string | undefined;
  let generation = 0;
  /** syncScope 在配置确认后才读取磁盘，切换修订时丢弃旧请求结果。 */
  const syncScope = () => {
    const scope = options?.scope();
    const next = options ? (scope === undefined ? undefined : `${key}:${encodeURIComponent(scope)}`) : key;
    if (storageKey === next) return;
    generation++; storageKey=next; snapshot=undefined; pending=undefined; refreshedAt=undefined;
    if (!next) return;
    try {
      const raw = localStorage.getItem(next);
      if (raw) {
        if (exceedsCacheBudget(raw)) throw new Error('Homepage cache exceeds size limit');
        const saved=object(JSON.parse(raw));
        if(saved.version===1 && typeof saved.savedAt==='number' && Date.now()-saved.savedAt>=0 && Date.now()-saved.savedAt<MAX_AGE) snapshot=normalize(saved.data);
      }
    } catch(reason) { logClientEvent('warn','home_cache_read_failed',{error:safeErrorMessage(reason)}); }
  };
  return {
    snapshot: () => {syncScope();return snapshot;},
    load: async (): Promise<T> => {
      await options?.prepare();
      syncScope();
      if(!storageKey) throw new Error('Homepage configuration is not confirmed');
      if (pending) return pending;
      // 启动预取、React 严格模式和首页挂载共用结果；磁盘缓存本身不能跳过后台更新。
      if (snapshot && refreshedAt !== undefined && Date.now() - refreshedAt < 5000) return Promise.resolve(snapshot);
      const owner=generation;
      const destination=storageKey;
      const operation=request().then(value => {
        syncScope();
        if(owner!==generation) throw new Error('Homepage configuration changed');
        snapshot = value;
        refreshedAt = Date.now();
        try {
          const raw = JSON.stringify({ version: 1, savedAt: refreshedAt, data: normalize(value) });
          if (exceedsCacheBudget(raw)) throw new Error("Homepage cache exceeds size limit");
          localStorage.setItem(destination, raw);
        } catch (reason) { logClientEvent("warn", "home_cache_write_failed", { error: safeErrorMessage(reason) }); }
        return value;
      }).finally(() => { if(pending===operation) pending=undefined; });
      pending=operation;
      return pending;
    },
  };
}

/** HomeCacheOptions 让缓存随包版本和服务端审核修订隔离。 */
interface HomeCacheOptions {
  /** scope 未确认时返回空值，此时不能显示磁盘旧首页。 */
  scope(): string | undefined;
  /** prepare 在首页请求前重新确认当前有效配置。 */
  prepare(): Promise<void>;
}

/** createPublicHomeCache 按 AppID 和接口环境隔离首页区域，保存完整推荐与二十条首屏公开目录；按审核修订隔离，缓存不参与验权，超限或落盘失败不影响网络结果。 */
export function createPublicHomeCache(
  appId: string,
  apiBaseUrl: string,
  loadCarousel: () => Promise<DramaSummary[]>,
  loadHot: () => Promise<DramaSummary[]>,
  loadRankings: () => Promise<CategoryRankingSection[]>,
  loadCatalog: () => Promise<HomePayload>,
  options?: HomeCacheOptions,
) {
  const prefix = `drama:public-home:v1:${encodeURIComponent(apiBaseUrl)}:${encodeURIComponent(appId)}`;
  const carousel = resource(`${prefix}:carousel`, (value) => dramas(value), loadCarousel,options);
  const hot = resource(`${prefix}:hot`, (value) => dramas(value), loadHot,options);
  const rankingSections = resource(`${prefix}:rankings`, rankings, loadRankings,options);
  return {
    carousel,
    hot,
    rankings: rankingSections,
    // 聚合视图仅服务现有组件测试和同步快照读取；生产网络请求始终是三个独立接口。
    sections: {
      snapshot: (): HomeSections | undefined => {
        const carouselValue = carousel.snapshot();
        const hotValue = hot.snapshot();
        const rankingValue = rankingSections.snapshot();
        return carouselValue || hotValue || rankingValue
          ? { carousel: carouselValue ?? [], hot: hotValue ?? [], rankings: rankingValue ?? [] }
          : undefined;
      },
      load: async (): Promise<HomeSections> => {
        const [carouselValue, hotValue, rankingValue] = await Promise.all([
          carousel.load(), hot.load(), rankingSections.load(),
        ]);
        return { carousel: carouselValue, hot: hotValue, rankings: rankingValue };
      },
    },
    catalog: resource(`${prefix}:catalog`, catalog, loadCatalog,options),
  };
}

/** createPublicRankingCache 按应用、接口环境和审核修订缓存分类目录及访问过的分类首屏；后续页仅从网络读取。 */
export function createPublicRankingCache(
  appId: string,
  apiBaseUrl: string,
  loadCategories: () => Promise<HomeRankingCategory[]>,
  loadPage: (tagId: string, input: Pick<DiscoveryQuery, "cursor" | "limit">) => Promise<HomeRankingPage>,
  options?: HomeCacheOptions,
) {
  // 使用独立版本键，旧版全分类大列表不会进入分页首屏。
  const prefix = `drama:public-home:v2:${encodeURIComponent(apiBaseUrl)}:${encodeURIComponent(appId)}`;
  const categories = resource(`${prefix}:ranking-categories`, (value): HomeRankingCategory[] => {
    if (!Array.isArray(value)) throw new Error("Invalid homepage ranking categories cache");
    return value.map(item => {
      const category = object(item);
      return { tagId: string(category.tagId), name: string(category.name) };
    });
  }, loadCategories, options);
  const firstPages = new Map<string, ReturnType<typeof resource<HomeRankingPage>>>();
  const firstPage = (tagId: string) => {
    let page = firstPages.get(tagId);
    if (!page) {
      page = resource(`${prefix}:ranking:${encodeURIComponent(tagId)}`, (value): HomeRankingPage => {
        const data = object(value);
        if (data.tagId !== tagId) throw new Error("Invalid homepage ranking cache category");
        return { tagId, name: string(data.name), dramas: dramas(data.dramas, 20),
          nextCursor: data.nextCursor === undefined ? undefined : string(data.nextCursor) };
      }, () => loadPage(tagId, { limit: 20 }), options);
      firstPages.set(tagId, page);
    }
    return page;
  };
  return {
    categories,
    snapshot: (tagId: string) => firstPage(tagId).snapshot(),
    load: async (tagId: string, input: Pick<DiscoveryQuery, "cursor" | "limit"> = {}): Promise<HomeRankingPage> => {
      if (!input.cursor && (input.limit ?? 20) === 20) return firstPage(tagId).load();
      await options?.prepare();
      const scope = options?.scope();
      if (options && scope === undefined) throw new Error("Homepage configuration is not confirmed");
      const page = await loadPage(tagId, input);
      // 后续页也必须遵守配置代次，不能把旧渠道或旧审核范围的数据追加到新首页。
      if (options && scope !== options.scope()) throw new Error("Homepage configuration changed");
      return page;
    },
  };
}
