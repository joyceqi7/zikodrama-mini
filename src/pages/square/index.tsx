import { useForegroundRefresh } from "../../components/useForegroundRefresh";
import { preloadDramaCovers } from "../../components/homeImagePreload";
import { usePlaybackPreload } from "./usePlaybackPreload";
import { HomeHighlights } from "../../components/HomeHighlights";
import { useHomeScrollAnchor } from "../../components/useHomeScrollAnchor";
import { getVisibilitySnapshot, observeVisibility } from "../../platform/tiktok/lifecycle";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Crown } from "lucide-react";
import { text as t } from "../../copy";

import { userMessage } from "../../api/userMessage";
import { BottomNav } from "../../components/BottomNav";
import { DramaPoster } from "../../components/DramaPoster";
import { VipDialog } from "../../components/VipDialog";
import type { DiscoveryPage, DiscoveryQuery, DramaSummary, HomePayload } from "../../domain/types";
import { useRuntime } from "../../runtime/RuntimeContext";
import { useAdExperience } from "../../runtime/useAdExperience";
import { latestDramaHistory, playbackEntryPath } from "../../domain/resumePlayback";
import { coverLoader } from "../../components/coverLoader";
import { preloadTheaterModule } from "../../runtime/theaterModule";

/** SquareFilters 在登录切换时保留用户的分类选择。 */
export interface SquareFilters {
  /** tag 是分类榜的官方标签 ID；空值表示默认展示首个分类，不筛选全部目录。 */
  tag: string;
}

interface SquarePageProps {
  /** subjectKey 用于隔离不同身份的视频预取，不重建公开目录。 */
  subjectKey?: string;
  /** filters 由 App 保存，避免身份就绪后重置首页筛选。 */
  filters?: SquareFilters;
  /** onFiltersChange 更新 App 保存的筛选；独立页面测试可使用组件自身状态。 */
  onFiltersChange?: (filters: SquareFilters) => void;
  /** session 存在时只读取公开目录；身份、个人库和播放均由 App 门禁管理。 */
  session?: {
    /** signingIn 表示已有登录请求，不再重复发起。 */
    signingIn: boolean;
    /** error 是经过统一映射的登录失败提示。 */
    error: string;
    /** onRetry 由用户主动重建身份。 */
    onRetry(): void;
    /** onNavigate 保存目标路径；登录完成后才进入个人页或播放器。 */
    onNavigate(path: string, drama?: DramaSummary): void;
  };
}

/** SquarePage 先由新增接口判断版本，命中时只挂载审核列表，原首页组件和请求保持原逻辑。 */
export function SquarePage(props: SquarePageProps = {}) {
  const runtime = useRuntime();
  const prepareIntent = (drama: DramaSummary) => {
    if (!getVisibilitySnapshot().visible) return;
    preloadTheaterModule();
    // 登录前只用目录图片；续播只读同一访客记录，避免预取错误分集的海报。
    const saved = props.session ? undefined : latestDramaHistory(runtime.localLibrary.history(), drama.id);
    const firstPoster = !saved || saved.episodeId === drama.firstEpisodeId ? drama.firstEpisodePosterUrl?.trim() : "";
    const poster = saved?.posterUrl?.trim() || firstPoster || drama.coverUrl.trim();
    if (poster) coverLoader.request(poster, "high", true);
  };
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState<import('../../domain/types').ReviewHome | undefined>(() => runtime.loadReviewHome ? undefined : { tiktokAppId: '', enabled: false, revision: 0, dramas: [] });
  const [error, setError] = useState('');
  useForegroundRefresh(runtime, () => setAttempt(value => value + 1));
  useEffect(() => {
    if (!runtime.loadReviewHome) return;
    let active = true;
    setReview(undefined); setError('');
    runtime.loadReviewHome().then(value => { if (active) setReview(value); }).catch(reason => {
      logClientEvent('error', 'review_home_load_failed', { error: safeErrorMessage(reason) });
      if (active) setError(userMessage(reason, t('home.catalogUnavailable')));
    });
    return () => { active = false; };
  }, [runtime, attempt]);
  if (review && !review.enabled) return <NormalSquarePage {...props} onPlaybackIntent={prepareIntent} />;
  return <main className="app-shell square-page">
    <header className="square-header"><h1 className="home-page-brand">{runtime.getApplicationBrand().name}</h1></header>
    <div className="square-content">
      {error ? <section className="inline-error" role="alert"><span>{error}</span><button type="button" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></section> : !review ? <div className="discovery-progress" role="status">{t('home.catalogLoading')}</div> : <section className="drama-shelf" aria-label="Short dramas">
        <div className="poster-grid">{review.dramas.map(drama => <DramaPoster key={drama.id} drama={drama}
          onPlaybackIntent={() => prepareIntent(drama)} onSelect={props.session ? () => props.session!.onNavigate(playbackEntryPath([], drama), drama) : undefined} />)}</div>
        {!review.dramas.length && <p className="empty-copy">{t('home.noDramas')}</p>}
      </section>}
    </div>
    <BottomNav onNavigate={props.session?.onNavigate} />
  </main>;
}

/** SquarePage 统一登录前后的首页；分类榜独立切换，全部已上线目录分页，个人行为等待可信身份。 */
function NormalSquarePage({ filters, onFiltersChange, session, subjectKey, onPlaybackIntent }: SquarePageProps & {
  /** onPlaybackIntent 让推荐和目录卡片共用剧场资源与海报的准备时机。 */
  onPlaybackIntent(drama: DramaSummary): void;
}) {
  const runtime = useRuntime();
  const { monetizationPolicy, vipState } = useAdExperience();
  const brand = runtime.getApplicationBrand();
  const [home, setHome] = useState<HomePayload | undefined>(() => runtime.getCachedPublicCatalog?.());
  const [localFilters, setLocalFilters] = useState<SquareFilters>({ tag: "" });
  const currentFilters = filters || localFilters;
  const { tag: selectedTag } = currentFilters;
  const updateFilters = (change: Partial<SquareFilters>) => (onFiltersChange || setLocalFilters)({ ...currentFilters, ...change });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  useForegroundRefresh(runtime, () => setCatalogAttempt(value => value + 1));
  const publicMode = Boolean(session);
  const discover = useCallback(async (input: DiscoveryQuery): Promise<DiscoveryPage> => {
    // 首页目录本身公开，身份就绪不应切换数据源并清空已加载的页面。
    if (!runtime.loadPublicCatalog) return runtime.api.discover(input);
    const catalog = await runtime.loadPublicCatalog!(input);
    return {
      items: catalog.dramas,
      nextCursor: catalog.nextCursor,
      // 老服务端尚未返回全部分类时，保留当前页真实标签；不注入示例分类。
      tags: catalog.tags || [...new Set(catalog.dramas.flatMap((drama) => drama.tags))],
    };
  }, [runtime]);
  const [discovery, setDiscovery] = useState<DiscoveryPage | undefined>(() => home ? {
    items: home.dramas, nextCursor: home.nextCursor, tags: home.tags ?? [],
  } : undefined);
  const preserveScroll = useHomeScrollAnchor();
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryLoadingMore, setDiscoveryLoadingMore] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [vipOpen, setVipOpen] = useState(false);
  const vipTriggerRef = useRef<HTMLButtonElement>(null);
  const hadVipDialogRef = useRef(false);
  // 首页公开目录先于身份加载；服务端确认启用 VIP 后显示入口，广告 Offer 在观看时独立获取。
  const showVipEntry = !publicMode && monetizationPolicy.status === "enabled" &&
    monetizationPolicy.vip.enabled;
  const vipDialogOpen = vipOpen && showVipEntry;
  useEffect(() => {
    if (vipDialogOpen) {
      hadVipDialogRef.current = true;
    } else if (hadVipDialogRef.current) {
      hadVipDialogRef.current = false;
      vipTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [vipDialogOpen]);
  const error = discoveryError;
  const discoveryVersion = useRef(0);
  const loadedPageCount = useRef(1);
  const loadMoreSentinel = useRef<HTMLDivElement | null>(null);
  // 同一目录版本只允许一个翻页请求，避免观察器连续通知重复追加。
  const loadingMoreVersion = useRef<number | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const bounds = document.getElementById("home-hot-title")?.getBoundingClientRect();
        // Hot Dramas 标题滚过固定顶栏后显示。
        setShowBackToTop(Boolean(bounds && bounds.top < 44));
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      window.removeEventListener("scroll", update);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const version = ++discoveryVersion.current;
    setDiscoveryLoading(true);
    setDiscoveryError("");
    setDiscoveryLoadingMore(false);
    const refreshCatalog = async () => {
      let page = await discover({ limit: 20 });
      preloadDramaCovers(page.items);
      for (let index = 1; index < loadedPageCount.current && page.nextCursor && active; index++) {
        const next = await discover({ limit: 20, cursor: page.nextCursor });
        preloadDramaCovers(next.items);
        page = { ...next, items: [...page.items, ...next.items] };
      }
      return page;
    };
    refreshCatalog().then((page) => {
      if (!active || version !== discoveryVersion.current) return;
      preloadDramaCovers(page.items);
      preserveScroll();
      setDiscovery(page);
      setHome({dramas:page.items,nextCursor:page.nextCursor});
    }).catch((reason: unknown) => {
      logClientEvent("error", runtime.loadPublicCatalog ? "public_catalog_load_failed" : "home_discovery_failed", { error: safeErrorMessage(reason) });
      if (active && version === discoveryVersion.current) {
        preserveScroll();
        setDiscoveryError(userMessage(reason, t("home.discoveryError")));
      }
    }).finally(() => {
      if (active && version === discoveryVersion.current) setDiscoveryLoading(false);
    });
    return () => { active = false; };
  }, [discover, runtime, catalogAttempt]);

  const dramas = discovery?.items || [];

  const pageRef = useRef<HTMLElement | null>(null);
  usePlaybackPreload(pageRef, runtime, !publicMode, subjectKey);

  useEffect(() => {
    if (publicMode) return;
    let visible = getVisibilitySnapshot().visible;
    let active = true;
    const off = observeVisibility(window.TTMinis, (value) => { visible = value; });
    // 不在进入首页时弹出，停留后定期复核；输入、弹窗和后台均不打断。
    const timer = window.setInterval(() => {
      void runtime.showInterstitialIfEligible?.(() => active && visible && !document.querySelector('[role="dialog"], input:focus, textarea:focus'));
    }, 30_000);
    return () => { active = false; off(); window.clearInterval(timer); };
  }, [publicMode, runtime]);

  const loadMore = useCallback(async () => {
    if (!discovery?.nextCursor || discoveryLoading || discoveryLoadingMore || discoveryError ||
      loadingMoreVersion.current === discoveryVersion.current) return;
    const version = discoveryVersion.current;
    loadingMoreVersion.current = version;
    setDiscoveryLoadingMore(true);
    setDiscoveryError("");
    try {
      const page = await discover({
        cursor: discovery.nextCursor,
        limit: 20,
      });
      if (version !== discoveryVersion.current) return;
      preloadDramaCovers(page.items);
      loadedPageCount.current += 1;
      setDiscovery((current) => current ? {
        ...page,
        items: [...current.items, ...page.items],
        tags: page.tags.length ? page.tags : current.tags,
      } : page);
    } catch (reason) {
      logClientEvent("error", "home_discovery_more_failed", { error: safeErrorMessage(reason) });
      if (version === discoveryVersion.current) {
        setDiscoveryError(userMessage(reason, t("home.discoveryError")));
      }
    } finally {
      if (loadingMoreVersion.current === version) loadingMoreVersion.current = null;
      if (version === discoveryVersion.current) setDiscoveryLoadingMore(false);
    }
  }, [discover, discovery, discoveryLoading, discoveryLoadingMore, discoveryError]);

  useEffect(() => {
    const sentinel = loadMoreSentinel.current;
    if (!sentinel || !discovery?.nextCursor || discoveryLoading || discoveryLoadingMore || discoveryError) return;
    // 接近列表底部时提前加载；失败后暂停，等待用户重试目录，避免自动请求循环。
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "0px 0px 240px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [discovery?.nextCursor, discoveryLoading, discoveryLoadingMore, discoveryError, loadMore]);

  return (
    <>
    <main ref={pageRef} inert={vipDialogOpen} className={`app-shell square-page${showVipEntry ? " has-vip-entry" : ""}`}>
      <header className="square-header">
        <h1 className="home-page-brand">{brand.name}</h1>
      </header>
      <div className="square-content">
        <HomeHighlights onNavigate={session?.onNavigate} onPlaybackIntent={onPlaybackIntent} selectedCategory={selectedTag} onCategoryChange={(tag) => updateFilters({ tag })} />

      {session && !session.signingIn && <section className="session-notice" aria-live="polite">
        <span>{t("app.browseWhileOffline")}</span>
        {session.error && <span>{session.error}</span>}
        {!session.signingIn && <button type="button" className="text-button" onClick={() => {
          session.onRetry();
          if (discoveryError) setCatalogAttempt((attempt) => attempt + 1);
        }}>{t("common.retry")}</button>}
      </section>}
      {error && <section className="inline-error" role="alert"><strong>{t("home.catalogUnavailable")}</strong><span>{error}</span>
        <button type="button" className="text-button" onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>{t("home.retryCatalog")}</button>
      </section>}

      <section className="drama-shelf" aria-labelledby="discover-title">
        <div className="section-heading">
          <h2 id="discover-title">More Drama</h2>
        </div>
        {discoveryLoading && !discovery && <div className="discovery-progress" role="status">{t("home.catalogLoading")}</div>}
        <div className="poster-grid">
          {dramas.map((drama) => (
            <DramaPoster
              key={drama.id}
              drama={drama}
              onPlaybackIntent={() => onPlaybackIntent(drama)}
              onSelect={session ? () => session.onNavigate(playbackEntryPath([], drama), drama) : undefined}
            />
          ))}
        </div>
        {!discoveryLoading && !error && discovery && !dramas.length && <p className="empty-copy">{t("home.noDramas")}</p>}
        <div ref={loadMoreSentinel} style={{ minHeight: 1 }} aria-hidden="true" />
        {discoveryLoadingMore && <div className="discovery-progress" role="status">{t("home.loadingMore")}</div>}
      </section>
      </div>
      {showBackToTop && <button type="button" className="home-back-to-top" aria-label="Back to top" onClick={() => {
        window.scrollTo({ top: 0, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }}><ArrowUp aria-hidden="true" /></button>}
      {showVipEntry && <button ref={vipTriggerRef} type="button" className={`home-vip-entry${vipState.active ? " active" : ""}`}
        aria-label={t(vipState.active ? "vip.entryActive" : "vip.entry")}
        aria-haspopup="dialog" aria-expanded={vipDialogOpen} onClick={() => setVipOpen(true)}>
        <Crown aria-hidden="true" />
      </button>}
      <BottomNav onNavigate={session?.onNavigate} />
    </main>
    {vipDialogOpen && <VipDialog open onClose={() => setVipOpen(false)} />}
    </>
  );
}
