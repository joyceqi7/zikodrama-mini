import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DramaSummary, HomeRankingPage } from "../domain/types";
import { useRuntime } from "../runtime/RuntimeContext";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import { useForegroundRefresh } from "./useForegroundRefresh";
import { useHomeScrollAnchor } from "./useHomeScrollAnchor";

interface HomeCategoryRankingsProps {
  /** selectedCategory 保留页面往返与登录前后的分类选择。 */
  selectedCategory?: string;
  /** onCategoryChange 将用户选择交给首页保存。 */
  onCategoryChange?: (tagId: string) => void;
  /** renderDrama 复用首页卡片的播放入口和封面加载规则。 */
  renderDrama: (drama: DramaSummary) => ReactNode;
}

/** appendRankingPage 按服务端顺序追加并去重，避免翻页期间运营调整产生重复卡片。 */
function appendRankingPage(current: HomeRankingPage, next: HomeRankingPage): HomeRankingPage {
  const seen = new Set(current.dramas.map(drama => drama.id));
  return { ...next, dramas: [...current.dramas, ...next.dramas.filter(drama => !seen.has(drama.id))] };
}

/** HomeCategoryRankings 先读取轻量分类，再请求所选分类；分页与迟到响应按分类和刷新代次隔离。 */
export function HomeCategoryRankings({ selectedCategory, onCategoryChange, renderDrama }: HomeCategoryRankingsProps) {
  const runtime = useRuntime();
  const [categories, setCategories] = useState(() => runtime.getCachedHomeRankingCategories?.());
  const [localTag, setLocalTag] = useState("");
  const selected = selectedCategory || localTag;
  const category = categories?.find(item => item.tagId === selected) ?? categories?.[0];
  const tagId = category?.tagId;
  const activeTag = useRef(tagId);
  activeTag.current = tagId;
  const [page, setPage] = useState<HomeRankingPage | undefined>(() => tagId ? runtime.getCachedHomeRankingPage?.(tagId) : undefined);
  const displayed = page?.tagId === tagId ? page : tagId ? runtime.getCachedHomeRankingPage?.(tagId) : undefined;
  const [categoriesError, setCategoriesError] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [categoriesAttempt, setCategoriesAttempt] = useState(0);
  const [pageAttempt, setPageAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  useForegroundRefresh(runtime, () => setRefresh(value => value + 1));
  const preserveScroll = useHomeScrollAnchor();
  const version = useRef(0);
  const loadingMoreVersion = useRef<number | undefined>(undefined);
  const failedMore = useRef(false);
  const depth = useRef({ tagId, count: 1 });
  const sentinel = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    setCategoriesError(false);
    runtime.loadHomeRankingCategories!().then(value => {
      if (!current) return;
      preserveScroll();
      setCategories(value);
    }).catch(reason => {
      logClientEvent("error", "home_ranking_categories_load_failed", { error: safeErrorMessage(reason) });
      if (current) setCategoriesError(true);
    });
    return () => { current = false; };
  }, [runtime, categoriesAttempt, refresh]);

  useEffect(() => {
    const owner = ++version.current;
    loadingMoreVersion.current = undefined;
    setLoadingMore(false);
    setPageError(false);
    failedMore.current = false;
    if (!tagId) { setPage(undefined); setLoading(false); return; }
    let current = true;
    const count = depth.current.tagId === tagId ? depth.current.count : 1;
    // 刷新失败时保留原展开深度，重试仍恢复同样页数。
    depth.current = { tagId, count };
    setPage(current => current?.tagId === tagId ? current : runtime.getCachedHomeRankingPage?.(tagId));
    setLoading(true);
    const load = async () => {
      let result = await runtime.loadHomeRankingPage!(tagId, { limit: 20 });
      let loaded = 1;
      // 前后台刷新恢复当前分类已展开的页数，切换分类始终从该分类第一页开始。
      while (loaded < count && result.nextCursor && current && activeTag.current === tagId) {
        const next = await runtime.loadHomeRankingPage!(tagId, { limit: 20, cursor: result.nextCursor });
        result = appendRankingPage(result, next);
        loaded++;
      }
      if (!current || owner !== version.current || activeTag.current !== tagId) return;
      preserveScroll();
      depth.current = { tagId, count: loaded };
      setPage(result);
    };
    void load().catch(reason => {
      logClientEvent("error", "home_ranking_page_load_failed", { tagId, error: safeErrorMessage(reason) });
      if (current && owner === version.current && activeTag.current === tagId) setPageError(true);
    }).finally(() => {
      if (current && owner === version.current && activeTag.current === tagId) setLoading(false);
    });
    return () => { current = false; if (version.current === owner) version.current++; };
  }, [runtime, tagId, pageAttempt, refresh]);

  const loadMore = useCallback(async (retry = false) => {
    if (!tagId || !displayed?.nextCursor || loading || loadingMore || (pageError && !retry) || loadingMoreVersion.current === version.current) return;
    const owner = version.current;
    loadingMoreVersion.current = owner;
    setPageError(false);
    setLoadingMore(true);
    try {
      const next = await runtime.loadHomeRankingPage!(tagId, { limit: 20, cursor: displayed.nextCursor });
      if (owner !== version.current || activeTag.current !== tagId) return;
      depth.current.count++;
      setPage(current => current?.tagId === tagId ? appendRankingPage(current, next) : next);
    } catch (reason) {
      logClientEvent("error", "home_ranking_more_failed", { tagId, error: safeErrorMessage(reason) });
      if (owner === version.current && activeTag.current === tagId) { failedMore.current = true; setPageError(true); }
    } finally {
      if (loadingMoreVersion.current === owner) loadingMoreVersion.current = undefined;
      if (owner === version.current && activeTag.current === tagId) setLoadingMore(false);
    }
  }, [runtime, tagId, displayed, loading, loadingMore, pageError]);

  useEffect(() => {
    if (!sentinel.current || !displayed?.nextCursor || loading || loadingMore || pageError || typeof IntersectionObserver === "undefined") return;
    // 接近当前分类底部时加载下一页；故障后停止自动请求，交由重试按钮恢复。
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "0px 0px 240px 0px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [displayed?.nextCursor, loading, loadingMore, pageError, loadMore]);

  if (categories?.length === 0 && !categoriesError) return null;
  return <section ref={section} data-home-anchor="rankings" className="home-category-rankings" aria-labelledby="home-ranking-title">
    <h2 id="home-ranking-title">Category Rankings</h2>
    {categoriesError && <div className="home-highlight-error" role="status">
      <span>Categories are unavailable.</span>
      <button type="button" onClick={() => setCategoriesAttempt(value => value + 1)}>Retry categories</button>
    </div>}
    {!categories && !categoriesError && <div className="discovery-progress" role="status">Loading categories...</div>}
    <div className="home-ranking-categories" role="group" aria-label="Ranking categories">
      {categories?.map(item => <button type="button" key={item.tagId} aria-pressed={item.tagId === tagId} onClick={() => {
        if (item.tagId === tagId) return;
        // 在长榜单底部切换时回到分类标题，避免列表缩短后直接落在下方目录。
        const top = section.current?.getBoundingClientRect().top;
        if (top !== undefined && top < 44) window.scrollTo({ top: Math.max(0, window.scrollY + top - 52), behavior: "instant" });
        setLocalTag(item.tagId);
        onCategoryChange?.(item.tagId);
      }}>{item.name}</button>)}
    </div>
    {category && <>
      <ol className="home-ranking-list" aria-label={`${category.name} rankings`} aria-busy={loading || loadingMore}>
        {displayed?.dramas.map(drama => <li key={drama.id} data-home-anchor={`ranking-${tagId}-${drama.id}`}>{renderDrama(drama)}</li>)}
      </ol>
      {(loading || loadingMore) && <div className="discovery-progress" role="status">{loadingMore ? "Loading more..." : "Loading dramas..."}</div>}
      {pageError && <div className="home-highlight-error" role="status">
        <span>Category dramas are unavailable.</span>
        <button type="button" onClick={() => {
          // 翻页失败直接重试失败游标，首屏失败才重新读取第一页。
          if (failedMore.current) void loadMore(true);
          else setPageAttempt(value => value + 1);
        }}>Retry dramas</button>
      </div>}
      {!loading && !pageError && displayed && displayed.dramas.length === 0 && !displayed.nextCursor && <p className="empty-copy">No dramas in this category.</p>}
      <div ref={sentinel} style={{ minHeight: 1 }} aria-hidden="true" />
      {!!displayed?.nextCursor && !loading && !loadingMore && !pageError && <button type="button" className="text-button home-ranking-more" onClick={() => void loadMore()}>Load more</button>}
    </>}
  </section>;
}
