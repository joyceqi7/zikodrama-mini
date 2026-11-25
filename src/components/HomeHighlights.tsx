import { useForegroundRefresh } from "./useForegroundRefresh";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHomeScrollAnchor } from "./useHomeScrollAnchor";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { Swiper, SwiperSlide } from "swiper/react";
import { A11y, Autoplay, EffectCoverflow, FreeMode } from "swiper/modules";
import type { Swiper as SwiperInstance } from "swiper/types";
import { MediaImage } from "./MediaImage";
import { HomeCategoryRankings } from "./HomeCategoryRankings";
import { preloadHomeCovers } from "./homeImagePreload";
import { useRuntime } from "../runtime/RuntimeContext";
import { playbackEntryPath } from "../domain/resumePlayback";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import type { DramaSummary, HomeSections } from "../domain/types";
import { getVisibilitySnapshot, observeVisibility } from "../platform/tiktok/lifecycle";
import "swiper/css";
import "swiper/css/effect-coverflow";
import "swiper/css/free-mode";
import "../home-ui.css";

interface HomeHighlightsProps {
  /** onNavigate 在身份尚未建立时交由 App 保存播放意图。 */
  onNavigate?: (path: string, drama: DramaSummary) => void;
  /** onPlaybackIntent 在按下推荐卡片时仅准备对应剧目的公开资源。 */
  onPlaybackIntent?: (drama: DramaSummary) => void;
  /** selectedCategory 是已选择的官方标签 ID；为空或失效时展示首个可用分类。 */
  selectedCategory?: string;
  /** onCategoryChange 保存分类选择，使登录前后的首页沿用同一榜单。 */
  onCategoryChange?: (tagId: string) => void;
}

/** HomeHighlights 独立加载推荐区域，失败不会阻断全部短剧列表。 */
export function HomeHighlights({ onNavigate, onPlaybackIntent, selectedCategory, onCategoryChange }: HomeHighlightsProps) {
  const runtime = useRuntime();
  const [sections, setSections] = useState<HomeSections | undefined>(() => {
    const carousel = runtime.getCachedHomeCarousel?.();
    const hot = runtime.getCachedHomeHot?.();
    const rankings = runtime.getCachedHomeRankings?.();
    return carousel || hot || rankings
      ? { carousel: carousel ?? [], hot: hot ?? [], rankings: rankings ?? [] }
      : runtime.getCachedHomeSections?.();
  });
  const preserveScroll = useHomeScrollAnchor();
  const currentSections = useRef(sections);
  currentSections.current = sections;
  const refreshSlide = useRef<string | undefined>(undefined);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useForegroundRefresh(runtime, () => setAttempt(value => value + 1));
  const [rankingTag, setRankingTag] = useState("");
  const [active, setActive] = useState(0);
  const slider = useRef<SwiperInstance | undefined>(undefined);
  const carouselRef = useRef<HTMLElement | null>(null);
  const hasPagedRankings = Boolean(runtime.loadHomeRankingCategories && runtime.loadHomeRankingPage);
  const hasSplitLoaders = Boolean(runtime.loadHomeCarousel && runtime.loadHomeHot && (hasPagedRankings || runtime.loadHomeRankings));
  const [settledCovers, setSettledCovers] = useState<Set<string>>(() => new Set());
  const activeCover = sections?.carousel[active]?.coverUrl.trim() ?? "";
  const nextCover = sections?.carousel[(active + 1) % sections.carousel.length]?.coverUrl.trim() ?? "";
  const activeCoverReady = (!activeCover || settledCovers.has(activeCover)) && (!nextCover || settledCovers.has(nextCover));
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  useEffect(() => {
    if (!hasSplitLoaders && !runtime.loadHomeSections) return;
    let current = true;
    setError(false);
    if (hasSplitLoaders) {
      // 推荐区域并行加载；新版分类组件独立读取目录与当前分类，不请求旧版完整榜单。
      void runtime.loadHomeCarousel!().then((carousel) => {
        if (!current) return;
        const previousCarousel = currentSections.current?.carousel ?? [];
        const previousIndex = previousCarousel.length ? (slider.current?.realIndex ?? 0) % previousCarousel.length : 0;
        refreshSlide.current = previousCarousel[previousIndex]?.id;
        preloadHomeCovers({ carousel, hot: currentSections.current?.hot ?? [] });
        preserveScroll();
        setSections(value => ({ carousel, hot: value?.hot ?? [], rankings: value?.rankings ?? [] }));
      }).catch((reason: unknown) => {
        logClientEvent("error", "home_carousel_load_failed", { error: safeErrorMessage(reason) });
        if (current) setError(true);
      });
      void runtime.loadHomeHot!().then((hot) => {
        if (!current) return;
        preloadHomeCovers({ carousel: currentSections.current?.carousel ?? [], hot });
        preserveScroll();
        setSections(value => ({ carousel: value?.carousel ?? [], hot, rankings: value?.rankings ?? [] }));
      }).catch((reason: unknown) => {
        logClientEvent("error", "home_hot_load_failed", { error: safeErrorMessage(reason) });
        if (current) setError(true);
      });
      if (!hasPagedRankings) void runtime.loadHomeRankings!().then((rankings) => {
        if (!current) return;
        preloadHomeCovers({ carousel: [], hot: [], rankings });
        preserveScroll();
        setSections(value => ({ carousel: value?.carousel ?? [], hot: value?.hot ?? [], rankings }));
      }).catch((reason: unknown) => {
        logClientEvent("error", "home_rankings_load_failed", { error: safeErrorMessage(reason) });
        if (current) setError(true);
      });
      return () => { current = false; };
    }
    runtime.loadHomeSections!().then((value) => {
      if (current) {
        // 先让浏览器发现首屏图片，再更新组件树，避免轮播初始化后才启动封面请求。
        preloadHomeCovers(value);
        preserveScroll();
        const previousCarousel = currentSections.current?.carousel ?? [];
        const previousIndex = previousCarousel.length ? (slider.current?.realIndex ?? 0) % previousCarousel.length : 0;
        refreshSlide.current = previousCarousel[previousIndex]?.id;
        setSections(value);
      }
    }).catch((reason: unknown) => {
      logClientEvent("error", "home_sections_load_failed", { error: safeErrorMessage(reason) });
      if (current) { preserveScroll(); setError(true); }
    });
    return () => { current = false; };
  }, [runtime, attempt, hasSplitLoaders, hasPagedRankings]);

  useLayoutEffect(() => {
    const id = refreshSlide.current;
    refreshSlide.current = undefined;
    if (!id || !sections || !slider.current || slider.current.destroyed) return;
    const index = Math.max(0, sections.carousel.findIndex(drama => drama.id === id));
    const swiper = slider.current;
    swiper.update();
    if (swiper.params.loop) swiper.slideToLoop(index, 0);
    else swiper.slideTo(index, 0);
    setActive(index);
  }, [sections]);

  useEffect(() => {
    const swiper = slider.current;
    const element = carouselRef.current;
    if (!swiper || !element || reducedMotion || (sections?.carousel.length ?? 0) < 2) return;
    let visible = getVisibilitySnapshot().visible;
    let inViewport = true;
    const update = () => {
      if (swiper.destroyed) return;
      // 页面在后台或轮播离开可视区时停止计时，返回后重新留出完整阅读时间。
      if (visible && inViewport && activeCoverReady) {
        if (!swiper.autoplay.running) swiper.autoplay.start();
      } else swiper.autoplay.stop();
    };
    let disposed = false;
    let off = observeVisibility(window.TTMinis, value => { visible = value; update(); });
    // 首屏可能早于 SDK 就绪；随后补上官方前后台事件订阅。
    if (runtime.whenPlatformReady) void runtime.whenPlatformReady().then(() => {
      if (disposed) return;
      off();
      visible = getVisibilitySnapshot().visible;
      update();
      off = observeVisibility(window.TTMinis, value => { visible = value; update(); });
    }).catch(reason => logClientEvent("warn", "home_visibility_sdk_unavailable", { error: safeErrorMessage(reason) }));
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
      inViewport = entries.some(entry => entry.isIntersecting);
      update();
    });
    observer?.observe(element);
    update();
    return () => { disposed = true; off(); observer?.disconnect(); if (!swiper.destroyed) swiper.autoplay.stop(); };
  }, [runtime, sections?.carousel.length, reducedMotion, activeCoverReady]);

  const selectSlide = (index: number) => {
    const swiper = slider.current;
    if (!swiper || swiper.destroyed) return;
    // 圆点对应服务端顺序，循环模式下不能使用重排后的 DOM 下标。
    if (swiper.params.loop) swiper.slideToLoop(index);
    else swiper.slideTo(index);
  };
  const renderLink = (drama: DramaSummary, variant: "hero" | "hot" | "ranking", priority: "high" | "eager" | "lazy" = "lazy") => {
    const hero = variant === "hero";
    const ranked = variant === "ranking";
    const path = playbackEntryPath(onNavigate ? [] : runtime.localLibrary.history(), drama);
    return <Link data-preload-resume="true" data-preload-drama={drama.id} data-preload-episode={drama.firstEpisodeId} key={drama.id} to={path} aria-label={hero ? `${drama.title} — Play Now` : ranked ? `${drama.title} — Play` : undefined} className={`home-${variant}-card`}
      onPointerDown={onPlaybackIntent && ((event) => { if (event.button <= 0 && event.isPrimary !== false) onPlaybackIntent(drama); })}
      onClick={onNavigate ? (event) => { event.preventDefault(); onNavigate(path, drama); } : undefined}>
      <MediaImage src={drama.coverUrl} loading={priority === "lazy" ? "lazy" : "eager"}
        sizes={hero ? "(max-width: 430px) 58vw, 250px" : ranked ? "88px" : "(max-width: 430px) 34vw, 146px"}
        maxThumbnailWidth={480}
        fetchPriority={priority === "high" ? "high" : priority === "lazy" ? "low" : "auto"} decoding="async"
        onSettled={hero ? () => setSettledCovers(current => {
          const source = drama.coverUrl.trim();
          if (current.has(source)) return current;
          return new Set(current).add(source);
        }) : undefined} />
      <span className="home-highlight-copy"><strong>{drama.title}</strong>
        {ranked && drama.description.trim() && <span className="home-ranking-description">{drama.description}</span>}
        {(hero || ranked) && <span className={ranked ? "home-ranking-play" : "home-play"}><Play size={14} fill="currentColor" aria-hidden="true" />{ranked ? "Play" : "Play Now"}</span>}
      </span>
    </Link>;
  };

  const rankings = sections?.rankings ?? [];
  const ranking = rankings.find(item => item.tagId === (selectedCategory ?? rankingTag)) ?? rankings[0];
  // Swiper 11 的 DOM 重排会在循环后把一侧邻项移出可视区；重复一轮提供稳定的前后缓冲，中间项仍按原顺序高亮。
  const baseCarousel = sections?.carousel ?? [];
  const carouselSlides = baseCarousel.length >= 3 ? [...baseCarousel, ...baseCarousel] : baseCarousel;

  return <>
    {error && <section className="home-highlight-error" role="status">
      <span>Recommendations are unavailable.</span>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
    </section>}
    {!sections && !error && (hasSplitLoaders || runtime.loadHomeSections) && <div className="home-highlights-loading" role="status" aria-label="Loading recommendations">
      <div aria-hidden="true">
        <div className="home-loading-covers">{[0, 1, 2].map(item => <span key={item} />)}</div>
        <div className="home-loading-dots"><span /></div>
        <h2>Hot Dramas</h2>
        <div className="home-loading-hot">{[0, 1, 2].map(item => <div key={item}><span /><i /></div>)}</div>
        <div className="home-loading-tags">{[0, 1, 2].map(item => <span key={item} />)}</div>
      </div>
    </div>}
    {!!sections?.carousel.length && <section data-home-anchor="carousel" ref={carouselRef} className="home-carousel" aria-label="Featured dramas" aria-roledescription="carousel">
      <Swiper className="home-carousel-rail" modules={[A11y, Autoplay, EffectCoverflow]}
        effect="coverflow" centeredSlides slidesPerView={1} speed={reducedMotion ? 0 : 200}
        // 单部不自动播放；多部每四秒切换，手动操作后继续，双部到末项后回到首项。
        autoplay={sections.carousel.length > 1 && !reducedMotion ? { delay: 4000, disableOnInteraction: false, pauseOnMouseEnter: true, stopOnLastSlide: false } : false}
        // 不足三部时禁用循环，避免补出重复剧目或破坏后台配置顺序。
        rewind={sections.carousel.length === 2}
        loop={sections.carousel.length >= 3}
        loopAdditionalSlides={sections.carousel.length >= 3 ? 1 : 0}
        coverflowEffect={{ rotate: 0, stretch: 32, depth: 0, scale: 0.82, slideShadows: false }}
        onSwiper={(swiper) => { slider.current = swiper; }}
        onSlideChange={(swiper) => setActive(swiper.realIndex % sections.carousel.length)}>
        {carouselSlides.map((drama, index) => {
          // 主卡与相邻卡先下载；其余封面接近可视区时再入队。
          return <SwiperSlide key={`${drama.id}-${index}`}>{renderLink(drama, "hero", index === 0 ? "high" : index === 1 ? "eager" : "lazy")}</SwiperSlide>;
        })}
      </Swiper>
      {sections.carousel.length > 1 && <div className="home-carousel-dots" aria-label="Choose featured drama">
        {sections.carousel.map((drama, index) => <button key={drama.id} type="button" aria-label={`Show ${drama.title}`} aria-pressed={index === active} onClick={() => selectSlide(index)}><span /></button>)}
      </div>}
    </section>}
    {!!sections?.hot.length && <section data-home-anchor="hot" className="home-hot" aria-labelledby="home-hot-title">
      <h2 id="home-hot-title">Hot Dramas</h2>
      <Swiper className="home-hot-rail" modules={[A11y, FreeMode]} slidesPerView="auto" spaceBetween={12}
        freeMode={{ enabled: true, momentum: !reducedMotion }} speed={reducedMotion ? 0 : 200}>
        {sections.hot.map((drama, index) => <SwiperSlide key={drama.id}>{renderLink(drama, "hot", index < 3 ? "eager" : "lazy")}</SwiperSlide>)}
      </Swiper>
    </section>}
    {hasPagedRankings ? <HomeCategoryRankings selectedCategory={selectedCategory} onCategoryChange={onCategoryChange} renderDrama={drama => renderLink(drama, "ranking")} /> : ranking && <section data-home-anchor="rankings" className="home-category-rankings" aria-labelledby="home-ranking-title">
      <h2 id="home-ranking-title">Category Rankings</h2>
      <div className="home-ranking-categories" role="group" aria-label="Ranking categories">
        {rankings.map(category => <button type="button" key={category.tagId} aria-pressed={category.tagId === ranking.tagId} onClick={() => (onCategoryChange ?? setRankingTag)(category.tagId)}>{category.name}</button>)}
      </div>
      <ol className="home-ranking-list" aria-label={`${ranking.name} rankings`}>
        {ranking.dramas.map(drama => <li key={drama.id} data-home-anchor={`ranking-${ranking.tagId}-${drama.id}`}>{renderLink(drama, "ranking")}</li>)}
      </ol>
    </section>}
  </>;
}
