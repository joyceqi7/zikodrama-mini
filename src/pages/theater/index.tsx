import { captureAdIntent } from "../../platform/tiktok/adIntent";
import { timePolicy } from "../../config/timePolicy";
import { remainingServerTime } from "../../domain/serverTime";
import { latestDramaHistory } from "../../domain/resumePlayback";
import { getVisibilitySnapshot, observeVisibility } from "../../platform/tiktok/lifecycle";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import {
  ArrowLeft,
  LockKeyhole,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { text as t } from "../../copy";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { userMessage } from "../../api/userMessage";
import type {
  AccessOffer,
  DramaDetail,
  DramaSummary,
  PlaybackIdentity,
  PlayResolveResult,
} from "../../domain/types";
import { createRewardClaim } from "../../domain/rewardClaim";
import { availableOffers } from "../../domain/offerStrategies";
import { IncompleteAdDialog } from "../../components/IncompleteAdDialog";
import { AutoUnlockDialog } from "../../components/AutoUnlockDialog";
import { useAutoUnlock } from "./useAutoUnlock";
import { useIncompleteAdPrompt } from "./useIncompleteAdPrompt";
import { VideoSwiper } from "../../components/video-swiper";
import { isPlayerInteractiveTarget } from "../../components/video-swiper/gesture";
import type { PlaybackEngine, PlaybackSource } from "../../player";
import { PlaybackProgressReporter } from "../../player/playbackProgress";
import { useRuntime } from "../../runtime/RuntimeContext";
import type { EntitlementChange } from "../../runtime/runtime";
import { useAdExperience } from "../../runtime/useAdExperience";
import type { SharePayload } from "../../platform/tiktok/share";
import { EpisodeSheet } from "../../components/EpisodeSheet";
import { ChevronUpIcon, DramaIcon } from "../../components/OfficialIcons";
import { coverThumbnail } from "../../components/coverThumbnail";
import { cachedPlaybackCover } from "../../runtime/playbackLaunchCover";
import { EntryAdGate } from "./EntryAdGate";
import { usePlaybackGate } from "./PlaybackGate";

type AccessRequiredResult = Extract<PlayResolveResult, { offer: unknown }>;

/** DirectPlaybackRecovery 只在当前分集的一次故障重建中保留位置和播放意图。 */
interface DirectPlaybackRecovery {
  /** route 限定恢复所属的业务分集。 */
  route: string;
  /** vid 限定可复用进度的媒体，替换媒体时从头开始。 */
  vid: string;
  /** visit 区分切走后再次进入同一分集。 */
  visit: number;
  /** positionSeconds 保存故障前有效位置，零表示无需定位。 */
  positionSeconds: number;
  /** shouldPlay 保留故障前意图，手动暂停不能被默认 autoplay 覆盖。 */
  shouldPlay: boolean;
  /** needsForegroundRefresh 表示重建经过后台，挂载前必须重新取得前台许可。 */
  needsForegroundRefresh: boolean;
}

function isAccessRequired(
  result: PlayResolveResult | undefined,
): result is AccessRequiredResult {
  return (
    result?.status === "access_required" ||
    result?.status === "reward_ad_required"
  );
}

/** isUsableRewardPlayback 防止领奖校验后又跨过前后台边界的旧许可被直接安装或放入缓存。 */
function isUsableRewardPlayback(playback: PlayResolveResult | undefined): playback is Extract<PlayResolveResult, { status: "playable" }> {
  return playback?.status === "playable" && (playback.playback.provider !== "byteplus_web" ||
    (remainingServerTime(playback.playback) ?? 0) > timePolicy.playbackRefreshAheadMs);
}

const PLAYER_CHROME_HIDE_DELAY_MS = 3_000;
const DEFAULT_PLAYBACK_RATE = 1;
const PLAYBACK_RATES = [0.75, DEFAULT_PLAYBACK_RATE, 1.25, 1.5, 2] as const;

function predecodePoster(url: string | undefined): void {
  const source = url?.trim();
  if (!source) return;
  const image = new Image();
  image.src = coverThumbnail(source, 720);
  void image.decode?.().catch(() => undefined);
}

// playbackSource 保持服务端验权的固定播放器合同，临时 Token 只在内存使用。
function playbackSource(playback: PlaybackIdentity): PlaybackSource {
  return { ...playback };
}

type CachedPlayback = {
  createdAt: number;
  promise: Promise<PlayResolveResult>;
  result?: PlayResolveResult;
};

const PLAYBACK_PREFETCH_TTL_MS = timePolicy.playbackCacheMs;

function cachePlayback(cache: Map<string, CachedPlayback>, key: string, promise: Promise<PlayResolveResult>, result?: PlayResolveResult): void {
  const entry: CachedPlayback = { createdAt: performance.now(), promise, result };
  cache.set(key, entry);
  void promise.then(resolved => {
    if (cache.get(key) === entry) entry.result = resolved;
  }, () => {
    if (cache.get(key) === entry) cache.delete(key);
  });
}

function invalidateRewardPlayback(cache: Map<string, CachedPlayback>): void {
  const now = performance.now();
  for (const [key, entry] of cache) {
    // 剧集奖励只增加权益；保留短期内已确认可播的相邻集，锁定和在途结果重新验权。
    if (entry.result?.status !== "playable" || now - entry.createdAt >= PLAYBACK_PREFETCH_TTL_MS ||
        (entry.result.playback.provider === "byteplus_web" && (remainingServerTime(entry.result.playback) ?? 0) <= timePolicy.playbackRefreshAheadMs)) cache.delete(key);
  }
}

/** TheaterPage 使用官方示例的剧场结构，播放和奖励沿用真实权益流程。 */
export function TheaterPage() {
  return <EntryAdGate><TheaterPlayback /></EntryAdGate>;
}

/** TheaterPlayback 逐集验权；每次进入或切集都从头播放，历史只用于入口选集与记录。 */
function TheaterPlayback() {
  const { dramaId = "", episodeId = "" } = useParams();
  const runtime = useRuntime();
  const playbackGate = usePlaybackGate();
  const gateDelay = playbackGate.entryAdDelay;
  const advanceAfterEntryAdRef = useRef("");
  const localLibrary = runtime.localLibrary;
  const location = useLocation();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlaybackEngine | undefined>(undefined);
  const mountedRef = useRef(false);
  const mountedResultRef = useRef<PlayResolveResult | undefined>(undefined);
  const rewardResumeRouteRef = useRef("");
  const detailRef = useRef<DramaDetail | undefined>(undefined);
  const fullDetailRef = useRef<DramaDetail | undefined>(undefined);
  const dramaIdRef = useRef(dramaId);
  const episodeIdRef = useRef(episodeId);
  const sourceRef = useRef<PlaybackSource | undefined>(undefined);
  // 实际播放路由在切集渲染时立即失效；旧内核事件不能使用新路由上报。
  const playbackRouteRef = useRef("");
  const renderedRouteRef = useRef(`${dramaId}:${episodeId}`);
  const savedEntry = latestDramaHistory(localLibrary?.history?.() ?? [], dramaId);
  const launchPoster = new URLSearchParams(location.search).get("firstEpisodePosterUrl")?.trim() || "";
  // 有历史时沿用该集海报；无历史时使用首页显式传入的首集首帧图。
  const entryCoverRef = useRef(
    savedEntry?.episodeId === episodeId && savedEntry.posterUrl
      ? savedEntry.posterUrl
      : launchPoster || cachedPlaybackCover(runtime, dramaId, episodeId),
  );
  const entryRouteRef = useRef(`${dramaId}:${episodeId}`);
  const playbackCacheRef = useRef(new Map<string, CachedPlayback>());
  // 本地目录请求的代次仅用于丢弃迟到预取，客户端不读取业务内容版本。
  const directoryDramaRef = useRef<string | undefined>(undefined);
  const directoryRevisionRef = useRef(0);
  const resultDirectoryRevisionRef = useRef(0);
  const progressReporterRef = useRef<PlaybackProgressReporter | undefined>(
    undefined,
  );
  // 每段播放冻结本地库与剧集元数据；换号后的旧回调不能写入新主体的历史。
  const progressContextRef = useRef({ library: localLibrary, episodeNumber: 1, durationSeconds: 0, posterUrl: "", drama: undefined as DramaSummary | undefined });
  const visibleRef = useRef(getVisibilitySnapshot().visible);
  const resumeRef = useRef(false);
  const overlayRef = useRef(false);
  const playbackBlockedRef = useRef(false);
  const resumeAfterBlockRef = useRef(false);
  const playedRouteRef = useRef("");
  // 同一分集再次进入时，旧 PLAYING 不能证明本次零进度快照是用户暂停。
  const playedVisitRef = useRef(0);
  const firstFrameRouteRef = useRef("");
  // 前台播放时持续维护相邻集短期授权；每个有效期最多一轮，慢请求不重叠。
  const adjacentRefreshRef = useRef<{ route: string; startedAt: number; pending: boolean } | undefined>(undefined);
  const componentAliveRef = useRef(true);
  const resolveRequestRef = useRef(0);
  // 订阅保持稳定，但回调必须使用当前路由的播放请求，不能刷新已经离开的剧集。
  const latestResolveEpisodeRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const entitlementRevisionRef = useRef(runtime.getEntitlementRevision?.() || 0);
  const chromeTimerRef = useRef<number | undefined>(undefined);
  const playbackRateRef = useRef(DEFAULT_PLAYBACK_RATE);
  const temporarySpeedRef = useRef(false);
  const [detail, setDetail] = useState<DramaDetail>();
  // 保留播放器后，回前台仍须先完成本集验权，不能由门禁放行抢先恢复旧许可。
  const [resumeChecking, setResumeChecking] = useState(false);
  // 每次进入一集最多自动重新验权一次；失败保留手动重试，广告不会重放。
  const directRecoveryRef = useRef("");
  // 普通进入与切集从头播放；只有当前访问的故障重建可以恢复位置与暂停意图。
  const directResumeRef = useRef<DirectPlaybackRecovery | undefined>(undefined);
  useEffect(() => {
    directRecoveryRef.current = "";
    directResumeRef.current = undefined;
    setResumeChecking(false);
  }, [dramaId, episodeId]);
  const [result, setResult] = useState<PlayResolveResult>();
  const [resultRoute, setResultRoute] = useState("");
  // 广告取消和同集重新验权沿用本次播放的结束位置，不会再次播放锁定片段。
  const previewBoundaryRef = useRef<{ route: string; position: number } | undefined>(undefined);
  const [previewFinishedRoute, setPreviewFinishedRoute] = useState("");
  const mountedPreviewRef = useRef(false);
  const [playbackCacheRevision, setPlaybackCacheRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [firstFrameRoute, setFirstFrameRoute] = useState("");
  const [bufferingRoute, setBufferingRoute] = useState("");
  const [adRunning, setAdRunning] = useState(false);
  const [manualAdRetry, setManualAdRetry] = useState(false);
  const unlockBusyRef = useRef(false);
  // 忙标记归属请求代次；后台或权益刷新撤销请求后，旧请求不能继续阻止重试。
  const retryBusyRef = useRef<number | undefined>(undefined);
  const [autoUnlockAttempted, setAutoUnlockAttempted] = useState(false);
  const episodeVisitRef = useRef(0);
  // 权益刷新和前后台重新验权仍属于本次切集，不能重复制造播放请求。
  const requestAttemptRef = useRef({ route: "", reported: false });
  const requestRoute = `${dramaId}:${episodeId}`;
  if (requestAttemptRef.current.route !== requestRoute) requestAttemptRef.current = { route: requestRoute, reported: false };
  const [pageVisible, setPageVisible] = useState(visibleRef.current);
  const autoUnlock = useAutoUnlock(runtime, `${dramaId}:${episodeId}`);
  const incompleteAd = useIncompleteAdPrompt(`${dramaId}:${episodeId}`);
  const [paused, setPaused] = useState(true);
  const [chromeVisible, setChromeVisible] = useState(false);
  // 操作期间暂停无操作计时，并由样式只展示该操作所需的控件。
  const [chromeInteraction, setChromeInteraction] = useState<"none" | "speeding" | "seeking">("none");
  const [playbackRate, setPlaybackRate] = useState(DEFAULT_PLAYBACK_RATE);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [switchingRoute, setSwitchingRoute] = useState("");
  // 脉冲只在当前集等待正常播放确认或缓冲恢复时显示，不由首帧事件单独撤除。
  const [loadingPulseRoute, setLoadingPulseRoute] = useState(`${dramaId}:${episodeId}`);
  // 只有当前集收到官方 PLAYING 回调，才允许页面把画面点击解释为暂停。
  const [normalPlaybackRoute, setNormalPlaybackRoute] = useState("");
  const [transitionCoverRoute, setTransitionCoverRoute] = useState("");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [transitionPoster, setTransitionPoster] = useState<{
    episodeId: string;
    url: string;
  }>();
  const { vipState } = useAdExperience();

  const blockingOverlay = resumeChecking || playbackGate.blocked || adRunning || !!autoUnlock.prompt || !!incompleteAd.prompt;
  overlayRef.current = blockingOverlay || drawerOpen;
  playbackBlockedRef.current = blockingOverlay;
  const renderedRoute = `${dramaId}:${episodeId}`;
  const entryPreview = resultRoute === renderedRoute && isAccessRequired(result) ? result.entryPreview : undefined;
  const waitingToUnlockPreview = !!entryPreview && playbackGate.entryAdTimePending;
  const lockedPreview = waitingToUnlockPreview && previewFinishedRoute !== renderedRoute ? entryPreview : undefined;
  const activePlayback = resultRoute === renderedRoute
    ? result?.status === "playable" ? result.playback : lockedPreview?.playback
    : undefined;
  const entryAdDelay = gateDelay || waitingToUnlockPreview;
  const entryAdDelayRef = useRef(entryAdDelay);
  entryAdDelayRef.current = entryAdDelay;
  const lockedPreviewRef = useRef(lockedPreview);
  lockedPreviewRef.current = lockedPreview;
  const entryAdTimeWasPending = useRef(playbackGate.entryAdTimePending);
  const finishLockedPreview = useCallback((route: string, seconds: number) => {
    if (previewBoundaryRef.current?.route === route) return;
    const engine = engineRef.current;
    const elapsed = engine?.snapshot().currentTime ?? 0;
    previewBoundaryRef.current = { route, position: Math.max(0, Math.min(seconds, elapsed)) };
    rewardResumeRouteRef.current = route;
    setPreviewFinishedRoute(route);
    engine?.pause();
  }, []);
  if (renderedRouteRef.current !== renderedRoute) {
    renderedRouteRef.current = renderedRoute;
    playbackRouteRef.current = "";
  }
  detailRef.current = detail;
  dramaIdRef.current = dramaId;
  episodeIdRef.current = episodeId;
  if (!progressReporterRef.current) {
    progressReporterRef.current = new PlaybackProgressReporter((input) => {
      const context = progressContextRef.current;
      context.library?.recordProgress({
        dramaId: input.dramaId,
        episodeId: input.episodeId,
        episodeNumber: context.episodeNumber,
        progressSeconds: input.currentTime,
        durationSeconds: input.duration || context.durationSeconds,
        posterUrl: context.posterUrl,
        drama: context.drama,
      });
    });
  }

  // 接受重新读取的目录时撤销旧预取；已挂载的视频继续播放，身份和本地进度不变。
  const acceptCurrentDirectory = useCallback((nextDetail: DramaDetail) => {
    const previousDrama = directoryDramaRef.current;
    directoryDramaRef.current = nextDetail.id;
    // 首次详情与起播并行，保留入口已有的短期许可，不增加首帧等待。
    if (!previousDrama) return;
    directoryRevisionRef.current += 1;
    playbackCacheRef.current.clear();
    adjacentRefreshRef.current = undefined;
    runtime.invalidatePlayback?.();
    const currentSource = sourceRef.current;
    if (currentSource) {
      // 用当前媒体替换旧候选窗口，撤销迟到任务但保留官方实例的连续播放能力。
      void runtime.preloadMedia?.([currentSource], 1).catch(reason => {
        logClientEvent("warn", "directory_preload_refresh_failed", { error: safeErrorMessage(reason) });
      });
    } else runtime.clearMediaPreload?.();
    setPlaybackCacheRevision(current => current + 1);
  }, [runtime]);

  // 当前访问的权威许可统一解除恢复门禁；后台请求不能冒充回前台后的新授权。
  const acceptDirectRecoveryAuthorization = useCallback((next: PlayResolveResult, route: string, authorizedInForeground: boolean): boolean => {
    const pending = directResumeRef.current;
    if (pending?.route !== route || pending.visit !== episodeVisitRef.current) return true;
    if (!authorizedInForeground || !visibleRef.current) return false;
    if (next.status !== "playable" || next.playback.provider !== "byteplus_web") {
      directResumeRef.current = undefined;
    } else {
      if (next.playback.vid !== pending.vid) pending.positionSeconds = 0;
      pending.vid = next.playback.vid;
      pending.needsForegroundRefresh = false;
    }
    return true;
  }, []);

  const resolveEpisode = useCallback(async (rewardSettled = false, fresh = false) => {
    const requestId = ++resolveRequestRef.current;
    const routeKey = `${dramaId}:${episodeId}`;
    const requestedInForeground = visibleRef.current;
    const cachedDetail = fullDetailRef.current?.id === dramaId
      ? fullDetailRef.current
      : undefined;
    const cachedPoster = cachedDetail?.episodes.find((item) => item.id === episodeId)?.posterUrl ||
      cachedDetail?.coverUrl || "";
    if (cachedPoster) setTransitionPoster({ episodeId, url: cachedPoster });
    setLoading(true);
    setError("");
    setPlaybackError("");
    try {
      const detailPromise = cachedDetail
        ? Promise.resolve(cachedDetail)
        : runtime.api.drama(dramaId);
      const requestAttempt = requestAttemptRef.current;
      const reportRequest = (metadata: DramaDetail) => {
        if (requestAttempt.reported || requestAttemptRef.current !== requestAttempt || !componentAliveRef.current || requestId !== resolveRequestRef.current) return;
        requestAttempt.reported = true;
        runtime.reportPlaybackEvent?.("video_play_request", metadata, episodeId);
      };
      void detailPromise.then((nextDetail) => {
        if (componentAliveRef.current && requestId === resolveRequestRef.current) {
          if (!cachedDetail) acceptCurrentDirectory(nextDetail);
          // 取得最新详情后只更新原主体已有历史；不改写观看进度，也不提前新增历史。
          const context = progressContextRef.current;
          context.library?.updateHistorySummary?.(nextDetail);
          if (context.drama?.id === nextDetail.id) context.drama = nextDetail;
          fullDetailRef.current = nextDetail;
          setDetail(nextDetail);
          reportRequest(nextDetail);
        }
      }).catch((reason) => {
        logClientEvent("warn", "episode_detail_load_failed", { error: safeErrorMessage(reason) });
      });
      const cacheKey = `${dramaId}:${episodeId}`;
      const cached = playbackCacheRef.current.get(cacheKey);
      const authorizationStartedAt = performance.now();
      const cacheValid = !fresh && !!cached && authorizationStartedAt - cached.createdAt < PLAYBACK_PREFETCH_TTL_MS &&
        (cached.result?.status !== "playable" || cached.result.playback.provider !== "byteplus_web" || (remainingServerTime(cached.result.playback) ?? 0) > timePolicy.playbackRefreshAheadMs);
      // 投放与相邻集已有正片授权时，在本次切换提交中直接安装；门禁仍由播放器挂载前检查。
      let nextResult: PlayResolveResult | undefined;
      if (requestedInForeground && !fresh) {
        if (!cacheValid) nextResult = runtime.getCachedPlayable?.(dramaId, episodeId);
        else if (cached.result?.status === "playable") nextResult = cached.result;
      }
      const authorizationReady = !!nextResult;
      if (!nextResult) {
        // 复用滑动前已发起的验权，避免再次等待网络；未确认、失败和重试均走原验权流程。
        const resultPromise = cacheValid
          ? cached.promise
          : !fresh && runtime.resolvePlayback
            ? runtime.resolvePlayback(dramaId, episodeId)
            : runtime.api.resolvePlay(dramaId, episodeId);
        if (!cacheValid) cachePlayback(playbackCacheRef.current, cacheKey, resultPromise);
        let directoryRevision = directoryRevisionRef.current;
        nextResult = await resultPromise;
        // 已兑现的 Promise 无法靠 runtime.clear 撤销；目录刷新期间返回的旧许可安装前重新验权。
        while (cacheValid && directoryRevision !== directoryRevisionRef.current) {
          if (!componentAliveRef.current || requestId !== resolveRequestRef.current) return;
          directoryRevision = directoryRevisionRef.current;
          nextResult = await (runtime.resolvePlayback?.(dramaId, episodeId) ?? runtime.api.resolvePlay(dramaId, episodeId));
        }
      }
      if (!componentAliveRef.current || requestId !== resolveRequestRef.current) return;
      if (!acceptDirectRecoveryAuthorization(nextResult, routeKey, requestedInForeground)) return;
      if (nextResult.status === "playable") {
        logClientEvent("info", "episode_authorization_ready", {
          dramaId, episodeId,
          stage: authorizationReady ? "cached_authorization" : "awaited_authorization",
          elapsedMs: performance.now() - authorizationStartedAt,
        });
      }
      // 授权中的当前集足以挂载播放器；完整分集稍后补齐，不阻断首帧。
      if (nextResult.status !== "unavailable") {
        const currentDetail = { ...nextResult.drama, episodes: [nextResult.episode] };
        setDetail(current => current?.id === dramaId && current.episodes.some(item => item.id === episodeId) ? current : currentDetail);
        reportRequest(currentDetail);
      }
      // 与目录并行发起的新验权直接采用；仅目录刷新前缓存的许可需要重新请求。
      resultDirectoryRevisionRef.current = directoryRevisionRef.current;
      setResult(nextResult);
      setResultRoute(routeKey);
      const targetPoster = nextResult.status === "playable"
        ? nextResult.playback.posterUrl
        : nextResult.status === "unavailable"
          ? cachedPoster
          : nextResult.episode.posterUrl;
      if (targetPoster) setTransitionPoster((current) => current?.episodeId === episodeId && current.url
        ? current
        : { episodeId, url: targetPoster });
      if (nextResult.status === "unavailable") setError(t("player.openError"));
    } catch (reason) {
      logClientEvent("error", "episode_access_refresh_failed", { error: safeErrorMessage(reason) });
      if (requestId !== resolveRequestRef.current) return;
      setSwitchingRoute((current) => current === routeKey ? "" : current);
      setTransitionCoverRoute((current) => current === routeKey ? "" : current);
      // 奖励已确认后的失败只影响播放恢复，不能再提示奖励结果未确认。
      setError(rewardSettled ? t("player.playbackError") : userMessage(reason, t("player.openError")));
    } finally {
      if (requestId === resolveRequestRef.current) setLoading(false);
    }
  }, [dramaId, episodeId, runtime, t, acceptDirectRecoveryAuthorization, acceptCurrentDirectory]);
  latestResolveEpisodeRef.current = resolveEpisode;

  // 新版结算直接携带完整目录；仅旧服务端或状态补充失败时沿用原详情查询。
  const acceptRewardDirectory = useCallback((dramaID: string, snapshot?: DramaDetail) => {
    const visit = episodeVisitRef.current;
    const revision = entitlementRevisionRef.current;
    const apply = (nextDetail: DramaDetail) => {
      if (!componentAliveRef.current || visit !== episodeVisitRef.current || revision !== entitlementRevisionRef.current ||
          nextDetail.id !== dramaIdRef.current) return;
      acceptCurrentDirectory(nextDetail);
      const context = progressContextRef.current;
      context.library?.updateHistorySummary?.(nextDetail);
      if (context.drama?.id === nextDetail.id) context.drama = nextDetail;
      fullDetailRef.current = nextDetail;
      setDetail(nextDetail);
    };
    if (snapshot?.id === dramaID) { apply(snapshot); return; }
    void runtime.api.drama(dramaID).then(apply).catch(reason => {
      logClientEvent("warn", "reward_directory_refresh_failed", { error: safeErrorMessage(reason) });
    });
  }, [runtime, acceptCurrentDirectory]);
  const rewardAccessRefreshRef = useRef<{
    /** route 标记刷新对应的分集，切集后不得复用。 */
    route: string;
    /** revision 区分不同奖励和权益失效通知。 */
    revision: number;
    /** promise 供权益通知与主动领奖收尾共享同一次验权。 */
    promise: Promise<void>;
  } | undefined>(undefined);
  const refreshRewardAccess = useCallback((preservePlayable = false, snapshot?: DramaDetail) => {
    const route = `${dramaId}:${episodeId}`;
    const revision = entitlementRevisionRef.current;
    const existing = rewardAccessRefreshRef.current;
    // 奖励通知先于 claimReward 返回；已经完成的同版本刷新也要复用，避免再次进入准备状态。
    if (existing?.route === route && existing.revision === revision) return existing.promise;
    detailRef.current = undefined;
    fullDetailRef.current = undefined;
    if (snapshot?.id === dramaId) acceptRewardDirectory(dramaId, snapshot);
    // 清除领奖前的锁定入口；恢复许可失败时只重试播放，不能让用户再看一次广告。
    setResult(current => isAccessRequired(current) ? undefined : current);
    runtime.invalidatePlayback?.();
    if (preservePlayable) invalidateRewardPlayback(playbackCacheRef.current);
    else playbackCacheRef.current.clear();
    playbackCacheRef.current.delete(route);
    const promise = resolveEpisode(true);
    rewardAccessRefreshRef.current = { route, revision, promise };
    return promise;
  }, [dramaId, episodeId, runtime, resolveEpisode, acceptRewardDirectory]);
  const latestRefreshRewardAccessRef = useRef(refreshRewardAccess);
  latestRefreshRewardAccessRef.current = refreshRewardAccess;
  const resolvedPlaybackRef = useRef({ result, resultRoute, loading });
  resolvedPlaybackRef.current = { result, resultRoute, loading };
  const appliedRewardPlaybackRef = useRef<{ playback: PlayResolveResult; visit: number } | undefined>(undefined);
  // 领奖返回与权益通知共用同一授权入口；只有当前业务分集的服务端许可可以直接安装。
  const applyRewardPlayback = useCallback((playback: PlayResolveResult | undefined, snapshot?: DramaDetail) => {
    if (!componentAliveRef.current || !isUsableRewardPlayback(playback) ||
        playback.drama.id !== dramaIdRef.current || playback.episode.id !== episodeIdRef.current) return false;
    const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
    const revision = entitlementRevisionRef.current;
    rewardAccessRefreshRef.current = { route, revision, promise: Promise.resolve() };
    const visit = episodeVisitRef.current;
    if (appliedRewardPlaybackRef.current?.playback === playback && appliedRewardPlaybackRef.current.visit === visit) return true;
    appliedRewardPlaybackRef.current = { playback, visit };
    // 取消旧验权结果的提交权；保留已确认可播的相邻集，锁定结果由新权益重新验权。
    resolveRequestRef.current += 1;
    acceptDirectRecoveryAuthorization(playback, route, visibleRef.current);
    invalidateRewardPlayback(playbackCacheRef.current);
    cachePlayback(playbackCacheRef.current, route, Promise.resolve(playback), playback);
    fullDetailRef.current = undefined;
    resultDirectoryRevisionRef.current = directoryRevisionRef.current;
    setResult(playback);
    setResultRoute(route);
    setLoading(false);
    acceptRewardDirectory(playback.drama.id, snapshot);
    return true;
  }, [acceptRewardDirectory, acceptDirectRecoveryAuthorization]);

  useLayoutEffect(() => {
    void resolveEpisode();
  }, [resolveEpisode]);

  useEffect(() => {
    if (!runtime.subscribeEntitlements) return;
    const refreshCurrentEpisode = (preservePlayable = false, snapshot?: DramaDetail) => {
      if (!componentAliveRef.current || runtime.getSessionState?.() === "recovery_required") return;
      // 与主动领取共享一次验权，优先使用结算目录；旧响应才并行补读目录。
      void latestRefreshRewardAccessRef.current(preservePlayable, snapshot);
    };
    const onEntitlementsChanged = (event: EntitlementChange) => {
      if (
        event.applicationId !== runtime.getApplicationID?.() ||
        event.visitorId !== runtime.getVisitorID() ||
        event.revision <= entitlementRevisionRef.current
      ) return;
      entitlementRevisionRef.current = event.revision;
      const currentRoute = `${dramaIdRef.current}:${episodeIdRef.current}`;
      if (event.rewardType === "episode_unlock" && event.dramaId === dramaIdRef.current &&
          event.episodeId === episodeIdRef.current && applyRewardPlayback(event.playback, event.drama)) {
        return;
      }
      const resolved = resolvedPlaybackRef.current;
      if (unlockBusyRef.current && event.rewardType === "episode_unlock" &&
          event.dramaId === dramaIdRef.current && event.episodeId && event.episodeId !== episodeIdRef.current &&
          !resolved.loading && resolved.result?.status === "playable" &&
          resolved.resultRoute === currentRoute) {
        // 同一连续广告流程只增加后续集权益，当前集已通过的播放许可不必再请求。
        // 锁定集和在途结果失效；将奖励事务确认的目标集许可直接放进缓存。
        invalidateRewardPlayback(playbackCacheRef.current);
        if (isUsableRewardPlayback(event.playback) && event.playback.drama.id === event.dramaId &&
            event.playback.episode.id === event.episodeId) {
          const targetRoute = `${event.dramaId}:${event.episodeId}`;
          cachePlayback(playbackCacheRef.current, targetRoute, Promise.resolve(event.playback), event.playback);
          setPlaybackCacheRevision(current => current + 1);
        }
        fullDetailRef.current = undefined;
        acceptRewardDirectory(event.dramaId, event.drama);
        return;
      }
      if (
        (event.rewardType === "episode_unlock" && event.dramaId === dramaIdRef.current) ||
        (event.rewardType === "vip_progress" && (runtime.getAdExperience().vipState.active || event.cause === "vip_recheck"))
      ) refreshCurrentEpisode(event.rewardType === "episode_unlock", event.drama);
    };
    const unsubscribe = runtime.subscribeEntitlements(onEntitlementsChanged);
    // 补领可能恰好发生在初次渲染和订阅之间；版本检查补上这一窗口内的权益变化。
    const revision = runtime.getEntitlementRevision?.() || 0;
    if (revision > entitlementRevisionRef.current) {
      entitlementRevisionRef.current = revision;
      refreshCurrentEpisode();
    }
    return unsubscribe;
  }, [runtime, applyRewardPlayback, acceptRewardDirectory]);

  useEffect(() => {
    // 每次进入剧集仅自动尝试一次；取消、失败和同集重新验权都不重复拉起。
    episodeVisitRef.current += 1;
    previewBoundaryRef.current = undefined;
    setPreviewFinishedRoute("");
    setAutoUnlockAttempted(false);
    rewardResumeRouteRef.current = "";
    setLoadingPulseRoute(`${dramaId}:${episodeId}`);
    setNormalPlaybackRoute("");
    firstFrameRouteRef.current = "";
    adjacentRefreshRef.current = undefined;
    setFirstFrameRoute("");
    setBufferingRoute("");
    setAutoplayBlocked(false);
    setChromeInteraction("none");
    // 已挂载 Player 切集时持续保留目标封面，直到目标媒体的实际首帧到达，
    // 避免滑页动画结束后直接暴露官方内核切源产生的短暂空帧。
    if (mountedRef.current) {
      const route = `${dramaId}:${episodeId}`;
      setSwitchingRoute(route);
      setTransitionCoverRoute(route);
    }
    const currentDetail = detailRef.current;
    const targetPoster = currentDetail?.episodes.find((item) => item.id === episodeId)?.posterUrl || "";
    if (targetPoster) setTransitionPoster({ episodeId, url: targetPoster });
  }, [dramaId, episodeId]);

  useEffect(() => {
    if (!detail) return;
    const index = detail.episodes.findIndex((item) => item.id === episodeId);
    if (index < 0) return;
    const nearby = detail.episodes.slice(Math.max(0, index - 1), index + 2);
    // 海报是切集反馈，不是播放凭据；锁定集也提前展示首图。
    nearby.forEach((episode) => predecodePoster(episode.posterUrl || detail.coverUrl));
  }, [detail, episodeId]);

  // 同一结果对象只在当前访问内去重；返回这集时必须重新确认预热提交状态。
  const rewardPreloadedResultRef = useRef<{ result: PlayResolveResult; visit: number } | undefined>(undefined);
  const lockedPreloadedResultRef = useRef<{ result: PlayResolveResult; visit: number } | undefined>(undefined);
  useEffect(() => {
    const route = `${dramaId}:${episodeId}`;
    const visit = episodeVisitRef.current;
    if (!pageVisible || loading || resultRoute !== route || !isAccessRequired(result) || !result.preload ||
        !runtime.preloadMedia ||
        (lockedPreloadedResultRef.current?.result === result && lockedPreloadedResultRef.current.visit === visit)) return;
    lockedPreloadedResultRef.current = { result, visit };
    const lockedSource = playbackSource(result.preload);
    const mountedSource = sourceRef.current;
    const window = mountedSource && mountedSource.vid !== lockedSource.vid
      ? [mountedSource, lockedSource].sort((left, right) =>
          (left.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (right.episodeNumber ?? Number.MAX_SAFE_INTEGER))
      : [lockedSource];
    // 提交官方预加载任务不挂载或切换播放器；领奖确认前始终停留在锁定状态。
    void runtime.preloadMedia(window, mountedSource ? 1 : 0).catch(reason => {
      logClientEvent("warn", "locked_media_preload_failed", { error: safeErrorMessage(reason) });
    });
  }, [dramaId, episodeId, result, resultRoute, loading, pageVisible, runtime]);
  useEffect(() => {
    const route = `${dramaId}:${episodeId}`;
    const visit = episodeVisitRef.current;
    if (!pageVisible || loading || resultRoute !== route || result?.status !== "playable" ||
      rewardAccessRefreshRef.current?.route !== route || firstFrameRouteRef.current === route ||
      (rewardPreloadedResultRef.current?.result === result && rewardPreloadedResultRef.current.visit === visit) ||
      !runtime.preloadMedia) return;
    rewardPreloadedResultRef.current = { result, visit };
    const unlockedSource = playbackSource(result.playback);
    const mountedSource = sourceRef.current;
    const rewardWindow = mountedSource && mountedSource.vid !== unlockedSource.vid
      ? [mountedSource, unlockedSource].sort((left, right) =>
          (left.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (right.episodeNumber ?? Number.MAX_SAFE_INTEGER))
      : [unlockedSource];
    // 首次锁集没有在播定位，Feed 不会加载当前集；先用 NORMAL 提交首段任务。
    // 已有实例始终保留 Feed，首帧之后再由相邻窗口接管，弹窗开合不切场景或清任务。
    const scene = mountedSource ? 1 : 0;
    void runtime.preloadMedia(rewardWindow, scene).catch((reason) => {
      logClientEvent("warn", "reward_media_preload_failed", { error: safeErrorMessage(reason) });
    });
  }, [dramaId, episodeId, result, resultRoute, loading, pageVisible, runtime]);

  // 只提交当前访问的下一集正片授权；切走、前后台变化或目录换代后的旧候选不能发起预取。
  const prefetchNextMediaInfo = useCallback((resolved: PlayResolveResult, targetEpisode: string, route: string, directoryRevision: number) => {
    if (resolved.status !== "playable" || resolved.episode.id !== targetEpisode) return;
    const visit = episodeVisitRef.current;
    const prepare = () => {
      if (!componentAliveRef.current || !visibleRef.current || overlayRef.current ||
          renderedRouteRef.current !== route || episodeVisitRef.current !== visit ||
          directoryRevisionRef.current !== directoryRevision || resolved.drama.id !== dramaIdRef.current) return;
      runtime.prefetchPlaybackInfo?.(resolved.playback);
    };
    // 已经出画、宿主未转发加载事件或正常连续切集时，仍沿用首帧回调后的预取。
    if (firstFrameRouteRef.current === route) { prepare(); return; }
    const source = sourceRef.current;
    if (source?.provider !== "byteplus_web" || playbackRouteRef.current !== route) return;
    engineRef.current?.whenInitialMediaLoading?.(source.vid, () => {
      // 等待期间可能已进入广告、试看或续播恢复；这些流程仍由原门禁控制。
      if (playbackGate.isBlocked() || entryAdDelayRef.current || mountedPreviewRef.current || directResumeRef.current) return;
      prepare();
    });
  }, [runtime, playbackGate.isBlocked]);

  // 切集、详情补全、原生广告和临时后台只暂停播放，不取消官方 Feed 任务；仅离页或换剧清理。
  useEffect(() => () => runtime.clearMediaPreload?.(), [runtime, dramaId]);

  useEffect(() => {
    if (resultRoute === `${dramaId}:${episodeId}` && result?.status === "unavailable") {
      runtime.clearMediaPreload?.();
    }
    if (!pageVisible || !detail || result?.status !== "playable" || resultRoute !== `${dramaId}:${episodeId}`) return;
    // 独立 Full 在出画前最多准备紧邻一集，播放器确认首集开始加载后才放行媒体信息预取。
    const direct = result.playback.provider === "byteplus_web";
    const earlyNext = direct && firstFrameRoute !== resultRoute;
    if (earlyNext && (overlayRef.current || runtime.isFullscreenAdActive?.())) return;
    const preloadMedia = direct ? undefined : runtime.preloadMedia;
    // 当前媒体继续留在 Feed 窗口；刷新前的许可不再缓存，其他分集使用新目录重新验权。
    const currentAuthorizationFresh = resultDirectoryRevisionRef.current === directoryRevisionRef.current;
    const currentIndex = detail.episodes.findIndex((item) => item.id === episodeId);
    if (currentIndex < 0) return;
    const targets = detail.episodes.slice(
      preloadMedia ? Math.max(0, currentIndex - 1) : currentIndex + 1,
      Math.min(detail.episodes.length, currentIndex + (earlyNext ? 2 : 3)),
    );
    let active = true;
    const directoryRevision = directoryRevisionRef.current;
    const missingTargets = targets.filter((episode) => {
      const cacheKey = `${dramaId}:${episode.id}`;
      if (episode.id === episodeId) {
        if (currentAuthorizationFresh) cachePlayback(playbackCacheRef.current, cacheKey, Promise.resolve(result), result);
        return false;
      }
      const cached = playbackCacheRef.current.get(cacheKey);
      return !cached || performance.now() - cached.createdAt >= PLAYBACK_PREFETCH_TTL_MS;
    });
    const batchPromise = missingTargets.length > 0 && runtime.resolvePlaybackBatch
      ? runtime.resolvePlaybackBatch(dramaId, missingTargets.map(episode => episode.id))
      : undefined;
    missingTargets.forEach((episode, index) => {
      const cacheKey = `${dramaId}:${episode.id}`;
      const promise = batchPromise
        ? batchPromise.then(results => {
            const resolved = results[index];
            if (!resolved) throw new Error("Adjacent playback batch is incomplete");
            return resolved;
          })
        : runtime.resolvePlayback?.(dramaId, episode.id) ?? runtime.api.resolvePlay(dramaId, episode.id);
      cachePlayback(playbackCacheRef.current, cacheKey, promise);
    });
    const prepared = new Map<string, PlaybackSource>([[episodeId, playbackSource(result.playback)]]);
    let publishedSignature = "";
    const publishPrepared = (): Promise<void> => {
      if (!preloadMedia || !active || directoryRevision !== directoryRevisionRef.current || !visibleRef.current ||
          firstFrameRouteRef.current !== `${dramaId}:${episodeId}`) return Promise.resolve();
      // 当前集真正出画后再从首页预热场景交接到连续播放，避免取消正在起播的入口资源。
      // 提交以当前集为中心的连续媒资窗口；锁定集只下载，不进入播放流程。
      const center = targets.findIndex(item => item.id === episodeId);
      let left = center;
      let right = center;
      while (left > 0 && prepared.has(targets[left - 1].id)) left--;
      while (right + 1 < targets.length && prepared.has(targets[right + 1].id)) right++;
      const mediaWindow = targets.slice(left, right + 1).map(item => prepared.get(item.id)!);
      const signature = mediaWindow.map(item => `${item.provider || "tiktok_minis"}:${item.albumId || ""}:${item.episodeId || ""}:${item.vid}`).join("|");
      if (signature === publishedSignature) return Promise.resolve();
      publishedSignature = signature;
      return preloadMedia(mediaWindow, 1)
        .catch((reason) => logClientEvent("warn", "episode_preload_failed", { error: safeErrorMessage(reason) }));
    };
    let publishQueued = false;
    const schedulePublish = () => {
      if (publishQueued) return;
      publishQueued = true;
      // 同轮缓存命中和批量授权回调先合并，再一次性替换官方列表；
      // 避免首帧或详情更新时先缩成当前集，随后逐集补回已准备好的候选。
      queueMicrotask(() => {
        publishQueued = false;
        void publishPrepared();
      });
    };
    const resolutions = targets.map((episode) => episode.id === episodeId
      ? Promise.resolve(result)
      : playbackCacheRef.current.get(`${dramaId}:${episode.id}`)!.promise);
    resolutions.forEach((promise, index) => {
      void promise.then((resolved) => {
        if (!active || directoryRevision !== directoryRevisionRef.current || targets[index].id === episodeId) return;
        if (direct) {
          if (index === 0) prefetchNextMediaInfo(resolved, targets[index].id, resultRoute, directoryRevision);
          return;
        }
        const media = resolved.status === "playable" ? resolved.playback : isAccessRequired(resolved) ? resolved.preload : undefined;
        if (!media) return;
        prepared.set(targets[index].id, playbackSource(media));
        schedulePublish();
      }).catch(() => undefined);
    });
    // 必须在已兑现 Promise 的回调之后排队；慢授权仍按实际到达渐进发布，不阻塞起播。
    schedulePublish();
    void Promise.allSettled(resolutions).then((results) => {
      // 单个相邻集失败不阻断其他已验权候选，失败只记录一次。
      const failure = results.find(item => item.status === "rejected");
      if (failure?.status === "rejected") logClientEvent("warn", "episode_preload_partial_failure", { error: safeErrorMessage(failure.reason) });
    });
    return () => {
      active = false;
    };
  }, [firstFrameRoute, detail, dramaId, episodeId, result, resultRoute, runtime, pageVisible, playbackCacheRevision, prefetchNextMediaInfo]);

  const refreshAdjacentPlayback = useCallback(() => {
    const currentDetail = fullDetailRef.current ?? detailRef.current;
    const currentDramaId = dramaIdRef.current;
    const currentEpisodeId = episodeIdRef.current;
    const route = `${currentDramaId}:${currentEpisodeId}`;
    if (!componentAliveRef.current || !visibleRef.current || overlayRef.current || runtime.isFullscreenAdActive?.() ||
        !currentDetail || currentDetail.id !== currentDramaId) return;
    if (sourceRef.current?.provider === "byteplus_web" && firstFrameRouteRef.current !== route) return;
    const previousRefresh = adjacentRefreshRef.current;
    const now = performance.now();
    if (previousRefresh?.route === route &&
        (previousRefresh.pending || now - previousRefresh.startedAt < PLAYBACK_PREFETCH_TTL_MS)) return;
    const currentIndex = currentDetail.episodes.findIndex(item => item.id === currentEpisodeId);
    if (currentIndex < 0) return;
    const nextEpisode = currentDetail.episodes[currentIndex + 1];
    const adjacent = [currentDetail.episodes[currentIndex - 1], nextEpisode]
      .filter((episode): episode is NonNullable<typeof episode> => !!episode);
    const targets = adjacent.filter((episode) => {
      const cached = playbackCacheRef.current.get(`${currentDramaId}:${episode.id}`);
      return !cached || performance.now() - cached.createdAt >= PLAYBACK_PREFETCH_TTL_MS;
    });
    if (!targets.length) return;
    const refresh = { route, startedAt: now, pending: true };
    adjacentRefreshRef.current = refresh;
    // 不延长旧许可：过期后随正常播放重新验权，与中途手动切集复用同一 Promise。
    // 最多刷新紧邻两集；暂停、弹窗及后台没有轮询，失败也等待下一有效期再重试。
    const batchPromise = runtime.resolvePlaybackBatch?.(currentDramaId, targets.map(episode => episode.id));
    const directoryRevision = directoryRevisionRef.current;
    const resolutions = targets.map((episode, index) => {
      const cacheKey = `${currentDramaId}:${episode.id}`;
      const promise = batchPromise
        ? batchPromise.then(results => {
            const resolved = results[index];
            if (!resolved) throw new Error("Adjacent playback refresh batch is incomplete");
            return resolved;
          })
        : runtime.resolvePlayback?.(currentDramaId, episode.id) ?? runtime.api.resolvePlay(currentDramaId, episode.id);
      cachePlayback(playbackCacheRef.current, cacheKey, promise);
      if (episode.id === nextEpisode?.id && sourceRef.current?.provider === "byteplus_web") {
        // 新授权可能更换 Token，媒体信息必须用更新后的授权重新预取。
        void promise.then(result => prefetchNextMediaInfo(result, episode.id, route, directoryRevision),
          () => { /* 相邻集验权故障由本轮汇总记录。 */ });
      }
      return promise;
    });
    void Promise.allSettled(resolutions).then(results => {
      refresh.pending = false;
      const failure = results.find(item => item.status === "rejected");
      if (failure?.status === "rejected") {
        logClientEvent("warn", "adjacent_playback_refresh_failed", {
          error: safeErrorMessage(failure.reason),
        });
      }
    });
  }, [runtime, prefetchNextMediaInfo]);

  const navigateByOffset = useCallback(
    (offset: number) => {
      const currentDetail = detailRef.current;
      if (!currentDetail) return;
      const index = currentDetail.episodes.findIndex(
        (item) => item.id === episodeIdRef.current,
      );
      const target = currentDetail.episodes[index + offset];
      if (target) navigate(`/watch/${currentDetail.id}/${target.id}`);
    },
    [navigate],
  );

  const selectEpisode = useCallback(
    (targetEpisodeId: string) => {
      if (targetEpisodeId && targetEpisodeId !== episodeIdRef.current) {
        navigate(`/watch/${dramaIdRef.current}/${targetEpisodeId}`);
      }
    },
    [navigate],
  );

  const returnHome = useCallback(() => {
    navigate("/", { replace: true });
  }, [navigate]);

  useLayoutEffect(() => {
    const deadlineReached = entryAdTimeWasPending.current && !playbackGate.entryAdTimePending;
    entryAdTimeWasPending.current = playbackGate.entryAdTimePending;
    if (!deadlineReached || playbackRouteRef.current !== renderedRoute) return;
    const engine = engineRef.current;
    if (!engine) return;
    // 到点先结束仍在准备或播放的试看，再由原门禁拉广告。试看位置只用于已验权正片的恢复。
    if (entryPreview && mountedPreviewRef.current) finishLockedPreview(renderedRoute, entryPreview.seconds);
    else if (!playbackGate.blocked || engine.snapshot().ended) return;
    if (!mountedRef.current) {
      // 构造中的播放器没有可以暂停的实例，作废本次挂载，广告放行后再按当前许可创建。
      engine.destroy();
      engineRef.current = undefined;
      sourceRef.current = undefined;
      playbackRouteRef.current = "";
      progressReporterRef.current?.clearTarget();
    } else if (!mountedPreviewRef.current) {
      // 还未出画的正片也保留起播意图，原门禁恢复后继续使用当前许可。
      resumeAfterBlockRef.current = true;
    }
  }, [entryPreview, finishLockedPreview, playbackGate.blocked, playbackGate.entryAdTimePending, renderedRoute]);

  useEffect(() => {
    // 直连片段准备期间沿用封面和加载状态，绕开预取缓存重新验权。
    if (!lockedPreview || lockedPreview.playback || loading || error || !pageVisible || blockingOverlay) return;
    const timer = window.setTimeout(() => void resolveEpisode(false, true), 2_000);
    return () => window.clearTimeout(timer);
  }, [lockedPreview, loading, error, pageVisible, blockingOverlay, resolveEpisode]);

  useEffect(() => {
    if (!entryAdDelay && !blockingOverlay && pageVisible && advanceAfterEntryAdRef.current === renderedRoute) {
      advanceAfterEntryAdRef.current = "";
      navigateByOffset(1);
    }
  }, [entryAdDelay, blockingOverlay, pageVisible, renderedRoute, navigateByOffset]);

  // 选集抽屉只是覆盖在同一播放器实例上，打开后仍须保持已开始的视频连续播放。
  const canStartPlayback = pageVisible && !blockingOverlay && !loading &&
    (!entryAdDelay || (result?.status === "playable" && result.episode.number === 1) || !!lockedPreview?.playback);
  const [preparedRewardRoute, setPreparedRewardRoute] = useState("");
  useEffect(() => {
    setPreparedRewardRoute("");
  }, [dramaId, episodeId]);
  useEffect(() => {
    // 奖励确认后暂停准备 Player，与媒体预加载并行。
    // setPreloadList 可能等待取流或下载；不能让它决定弹窗关闭后的建播放器时机。
    if (pageVisible && !loading &&
        result?.status === "playable" && resultRoute === `${dramaId}:${episodeId}` &&
        rewardAccessRefreshRef.current?.route === resultRoute &&
        !runtime.isFullscreenAdActive?.()) setPreparedRewardRoute(resultRoute);
  }, [pageVisible, loading, result, resultRoute, dramaId, episodeId, runtime]);
  // 已开始的暂停准备跨弹窗关闭和后续原生广告保留，避免异步初始化被 effect 清理后重新创建。
  const canPreparePlayback = canStartPlayback || (preparedRewardRoute === `${dramaId}:${episodeId}` && !loading);
  // 自动恢复、手动重试和后台中断共用释放入口；新许可必须安装到新的独立内核。
  const prepareDirectRecovery = useCallback((): boolean => {
    const currentDramaId = dramaIdRef.current;
    const currentEpisodeId = episodeIdRef.current;
    const route = `${currentDramaId}:${currentEpisodeId}`;
    const resolved = resolvedPlaybackRef.current;
    const visit = episodeVisitRef.current;
    const pending = directResumeRef.current?.route === route && directResumeRef.current.visit === visit
      ? directResumeRef.current : undefined;
    const currentSource = playbackRouteRef.current === route ? sourceRef.current : undefined;
    const authorizedSource = resolved.resultRoute === route && resolved.result?.status === "playable"
      ? resolved.result.playback : undefined;
    const directSource = currentSource?.provider === "byteplus_web" ? currentSource
      : authorizedSource?.provider === "byteplus_web" ? authorizedSource : undefined;
    if (!componentAliveRef.current || (!directSource && !pending)) return false;
    const snapshot = currentSource ? engineRef.current?.snapshot() : undefined;
    if (!pending) {
      // 未 READY 的内核快照默认暂停；此时沿用原重建意图或源的 autoplay，不误判为手动暂停。
      const hasPlaybackSnapshot = snapshot && (snapshot.currentTime > 0 || (playedRouteRef.current === route && playedVisitRef.current === visit));
      const shouldPlay = hasPlaybackSnapshot
        ? (!snapshot.paused && !snapshot.ended) || (!visibleRef.current && resumeRef.current) || (overlayRef.current && resumeAfterBlockRef.current)
        : currentSource?.autoplay !== false;
      directResumeRef.current = {
        route, vid: directSource!.vid, visit,
        positionSeconds: snapshot && Number.isFinite(snapshot.currentTime) && snapshot.currentTime > 0 && !snapshot.ended
          ? snapshot.currentTime : 0,
        shouldPlay,
        needsForegroundRefresh: !visibleRef.current,
      };
    }
    // 已开始重建但尚未 READY 时保留故障前快照，不能被新内核的零进度和默认暂停覆盖。
    progressReporterRef.current?.flush(snapshot);
    progressReporterRef.current?.clearTarget();
    engineRef.current?.destroy();
    engineRef.current = undefined;
    mountedRef.current = false;
    mountedResultRef.current = undefined;
    sourceRef.current = undefined;
    playbackRouteRef.current = "";
    playbackCacheRef.current.clear();
    runtime.invalidatePlayback?.();
    // 清除旧许可，等待新请求期间不能因其他重渲染再次挂载失效源。
    setResult(undefined);
    setResultRoute("");
    setLoading(true);
    return true;
  }, [runtime]);
  const refreshDirectRecovery = useCallback(async (): Promise<void> => {
    const pending = directResumeRef.current;
    if (!pending || !componentAliveRef.current) return;
    const { route, visit } = pending;
    const currentDramaId = dramaIdRef.current;
    const currentEpisodeId = episodeIdRef.current;
    // 每轮前台恢复都撤销此前请求的提交权，包括后台迟到及切走再回到同集的响应。
    const requestId = ++resolveRequestRef.current;
    logClientEvent("info", "direct_playback_authorization_refresh_started", { dramaId: currentDramaId, episodeId: currentEpisodeId });
    const isCurrentRecovery = () => componentAliveRef.current && requestId === resolveRequestRef.current &&
      visit === episodeVisitRef.current && `${dramaIdRef.current}:${episodeIdRef.current}` === route;
    // 直接重新验权，不消费缓存 Token，也不重新触发已完成的入剧广告。
    try {
      const next = await runtime.api.resolvePlay(currentDramaId, currentEpisodeId);
      if (!isCurrentRecovery() || !visibleRef.current) return;
      if (!acceptDirectRecoveryAuthorization(next, route, true)) return;
      setPlaybackError("");
      setError(next.status === "unavailable" ? t("player.openError") : "");
      resultDirectoryRevisionRef.current = directoryRevisionRef.current;
      setResult(next);
      setResultRoute(route);
      setLoading(false);
    } catch (reason) {
      logClientEvent("error", "direct_playback_authorization_refresh_failed", { dramaId: currentDramaId, episodeId: currentEpisodeId, error: safeErrorMessage(reason) });
      if (isCurrentRecovery() && visibleRef.current) {
        setLoading(false);
        setPlaybackError(t("player.playbackError"));
      }
    }
  }, [runtime, acceptDirectRecoveryAuthorization]);
  // mount 回调跨切源复用；自动恢复读取当前路由且每次进入最多一次，显式重试另起一轮。
  const recoverDirectAuthorization = useCallback((): boolean => {
    const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
    const resolved = resolvedPlaybackRef.current;
    if (!componentAliveRef.current || playbackRouteRef.current !== route || resolved.resultRoute !== route ||
        resolved.result?.status !== "playable" || resolved.result.playback.provider !== "byteplus_web" ||
        directRecoveryRef.current === route || !prepareDirectRecovery()) return false;
    directRecoveryRef.current = route;
    void refreshDirectRecovery();
    return true;
  }, [prepareDirectRecovery, refreshDirectRecovery]);
  useEffect(() => {
    const engine = engineRef.current;
    if (blockingOverlay) {
      if (engine && !engine.snapshot().paused && !engine.snapshot().ended) {
        resumeAfterBlockRef.current = true;
      }
      // 同时撤销尚未 READY 的延迟播放意图。
      engine?.pause();
      return;
    }
    if ((!resumeAfterBlockRef.current && rewardResumeRouteRef.current !== `${dramaId}:${episodeId}`) || !pageVisible ||
        runtime.isFullscreenAdActive?.() || !activePlayback) return;
    // 广告回程若目标是新一集，先让保留的官方实例完成 playNext；不能抢先恢复旧媒体。
    if (playbackRouteRef.current !== `${dramaId}:${episodeId}` || !mountedRef.current || mountedResultRef.current !== result) return;
    resumeAfterBlockRef.current = false;
    rewardResumeRouteRef.current = "";
    void engineRef.current?.play().catch((reason) => {
      logClientEvent("warn", "overlay_playback_resume_failed", { error: safeErrorMessage(reason) });
      setPlaybackError(t("player.playbackError"));
    });
  }, [activePlayback, blockingOverlay, pageVisible, result, dramaId, episodeId, t, runtime]);
  useEffect(() => {
    const matchesRoute = resultRoute === `${dramaId}:${episodeId}`;
    if (!rootRef.current || !activePlayback) {
      if (matchesRoute && result?.status === "unavailable") {
        setSwitchingRoute("");
        setTransitionCoverRoute("");
        engineRef.current?.destroy();
        engineRef.current = undefined;
        mountedRef.current = false;
      }
      return;
    }
    // 广告关闭、领奖与 minis.show 的先后不固定；前台且遮罩收尾后才起播。
    if (!canPreparePlayback || directResumeRef.current?.needsForegroundRefresh) return;
    const source = playbackSource(activePlayback);
    const recovery = directResumeRef.current;
    if (!canStartPlayback || (recovery?.route === resultRoute && recovery.visit === episodeVisitRef.current && !recovery.shouldPlay)) source.autoplay = false;
    const firstEntryPosterUrl = entryRouteRef.current === `${dramaId}:${episodeId}` && !savedEntry
      ? launchPoster
      : "";
    const playbackPosterUrl = firstEntryPosterUrl || source.posterUrl || "";
    // 广告领奖会刷新权益并生成新的结果对象，但当前媒体标识通常未变。此时调用官方 playNext
    // 会触发其切源首帧过渡，造成画面短暂缩放；复用已挂载内核，仅恢复播放即可。
    const sameMountedSource = mountedRef.current && playbackRouteRef.current === `${dramaId}:${episodeId}` &&
      sourceRef.current?.provider === source.provider && sourceRef.current?.vid === source.vid && sourceRef.current?.albumId === source.albumId &&
      sourceRef.current?.episodeId === source.episodeId;
    if (sameMountedSource) {
      mountedPreviewRef.current = !!lockedPreview;
      mountedResultRef.current = result;
      engineRef.current?.setPlaybackRate?.(playbackRateRef.current);
      if (rewardResumeRouteRef.current === `${dramaId}:${episodeId}` && visibleRef.current &&
        !overlayRef.current && !runtime.isFullscreenAdActive?.()) {
        rewardResumeRouteRef.current = "";
        if (engineRef.current?.snapshot().paused) {
          void engineRef.current.play().catch((reason) => {
            logClientEvent("warn", "reward_playback_resume_failed", { error: safeErrorMessage(reason) });
            if (componentAliveRef.current) setPlaybackError(t("player.playbackError"));
          });
        }
      }
      return;
    }
    let cancelled = false;
    const mountOrSwitch = async () => {
      const boundary = previewBoundaryRef.current;
      if (source.provider === "byteplus_web" && result?.status === "playable" &&
          boundary?.route === resultRoute && (!engineRef.current || mountedPreviewRef.current)) {
        // 用新授权创建正片内核，避免片段的迟到结束事件作用到正片。
        const end = source.durationSeconds || Infinity;
        source.startTime = Math.min(boundary.position, Math.max(0, end - 0.05));
        setFirstFrameRoute("");
        setLoadingPulseRoute(resultRoute);
        progressReporterRef.current?.clearTarget();
        const previous = engineRef.current;
        engineRef.current = undefined;
        mountedRef.current = false;
        previous?.destroy();
      }
      if (!engineRef.current)
        engineRef.current = runtime.createPlaybackEngine();
      const currentEngine = engineRef.current;
      mountedPreviewRef.current = !!lockedPreview;
      const selectProgressContext = () => {
        // 页面主体只由 App 的已提交 key 更换；语言重渲染或切集不能把旧 Player 重新绑定到安装中的新账号。
        const library = progressContextRef.current.library;
        progressContextRef.current = { library, episodeNumber: source.episodeNumber || 1, durationSeconds: source.durationSeconds || 0, posterUrl: playbackPosterUrl,
          drama: detailRef.current?.id === dramaId ? detailRef.current : undefined };
      };
      const pauseIfPlaybackIsBlocked = () => {
        if (!visibleRef.current || playbackGate.isBlocked() || overlayRef.current || runtime.isFullscreenAdActive?.()) engineRef.current?.pause();
      };
      const isCurrentPlayback = () => componentAliveRef.current &&
        engineRef.current === currentEngine && playbackRouteRef.current === `${dramaIdRef.current}:${episodeIdRef.current}`;
      playbackRouteRef.current = `${dramaId}:${episodeId}`;
      if (!mountedRef.current) {
        sourceRef.current = source;
        selectProgressContext();
        progressReporterRef.current?.setTarget(dramaId, episodeId);
        const mountingEngine = engineRef.current;
        // 同一内核只发起一次定位；保留恢复上下文直到内核确认目标位置，异步 seek 不能提前消费。
        let requestedRestorePosition: number | undefined;
        const restoreDirectPosition = () => {
          if (!isCurrentPlayback() || engineRef.current !== mountingEngine) return;
          const pending = directResumeRef.current;
          const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
          if (pending?.route !== route || pending.visit !== episodeVisitRef.current ||
              sourceRef.current?.provider !== "byteplus_web" || sourceRef.current.vid !== pending.vid) return;
          try {
            if (!pending.shouldPlay) mountingEngine.pause();
            if (pending.positionSeconds > 0) {
              const snapshot = mountingEngine.snapshot();
              // READY/COMPLETE 只保证实例和 video 已创建；时长未就绪时 seek 会被 SDK 裁剪成零。
              if (!Number.isFinite(snapshot.duration) || snapshot.duration <= 0 ||
                  (snapshot.readyState !== undefined && snapshot.readyState < 1)) return;
              const target = Math.min(pending.positionSeconds, snapshot.duration);
              if (requestedRestorePosition === undefined) {
                requestedRestorePosition = target;
                mountingEngine.seek(target);
              }
              const restoredPosition = mountingEngine.snapshot().currentTime;
              if (!Number.isFinite(restoredPosition) || Math.abs(restoredPosition - requestedRestorePosition) > 0.25) return;
            }
            directResumeRef.current = undefined;
          } catch (reason) {
            logClientEvent("error", "direct_playback_position_restore_failed", { dramaId: dramaIdRef.current, episodeId: episodeIdRef.current, error: safeErrorMessage(reason) });
            // 定位故障保留位置给显式重试；释放内核，避免继续从头播放或循环自动验权。
            progressReporterRef.current?.clearTarget();
            mountingEngine.destroy();
            engineRef.current = undefined;
            mountedRef.current = false;
            sourceRef.current = undefined;
            playbackRouteRef.current = "";
            setResult(undefined);
            setResultRoute("");
            setPlaybackError(t("player.playbackError"));
          }
        };
        const mounted = await mountingEngine.mount(
          rootRef.current!,
          source,
          {
            onReady: () => {
              if (!isCurrentPlayback()) return;
              restoreDirectPosition();
              pauseIfPlaybackIsBlocked();
            },
            onSeeked: restoreDirectPosition,
            onFirstFrame: (vid) => {
              if (!isCurrentPlayback() || sourceRef.current?.vid !== vid || directResumeRef.current) return;
              pauseIfPlaybackIsBlocked();
              const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
              const firstFrameForRoute = firstFrameRouteRef.current !== route;
              firstFrameRouteRef.current = `${dramaIdRef.current}:${episodeIdRef.current}`;
              if (firstFrameForRoute) runtime.reportPlaybackQuality?.("player_first_frame");
              setFirstFrameRoute(firstFrameRouteRef.current);
              setSwitchingRoute((current) => current === firstFrameRouteRef.current ? "" : current);
              setTransitionCoverRoute((current) => current === firstFrameRouteRef.current ? "" : current);
              setPlaybackError("");
              setTransitionPoster((current) =>
                current?.episodeId === episodeIdRef.current ? undefined : current,
              );
            },
            onPlay: () => {
              if (!isCurrentPlayback()) return;
              if ((mountedPreviewRef.current && previewBoundaryRef.current?.route === playbackRouteRef.current) ||
                  !visibleRef.current || playbackGate.isBlocked() || overlayRef.current || runtime.isFullscreenAdActive?.()) {
                if (!visibleRef.current) resumeRef.current = true;
                engineRef.current?.pause();
                return;
              }
              playedRouteRef.current = `${dramaIdRef.current}:${episodeIdRef.current}`;
              playedVisitRef.current = episodeVisitRef.current;
              const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
              setNormalPlaybackRoute(route);
              setLoadingPulseRoute((current) => current === route ? "" : current);
              if (detailRef.current) runtime.reportPlaybackEvent?.("ep_play", detailRef.current, episodeIdRef.current);
              // 官方 Player 自恢复成功后撤销旧错误，避免友好提示遮挡已恢复的视频。
              setPlaybackError("");
              setPaused(false);
            },
            onBufferingChange: (buffering) => {
              if (!isCurrentPlayback()) return;
              const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
              setBufferingRoute(buffering ? route : "");
              if (buffering) {
                setLoadingPulseRoute(route);
                setNormalPlaybackRoute("");
              }
              if (buffering) runtime.reportPlaybackQuality?.("player_stall");
            },
            onSeekingChange: (seeking) => {
              if (!isCurrentPlayback()) return;
              if (chromeTimerRef.current !== undefined) window.clearTimeout(chromeTimerRef.current);
              chromeTimerRef.current = undefined;
              setChromeInteraction(seeking ? "seeking" : "none");
              setChromeVisible(true);
            },
            onAutoplayBlocked: (muted) => {
              if (!isCurrentPlayback()) return;
              setAutoplayBlocked(true);
              runtime.reportPlaybackQuality?.("player_autoplay_blocked");
              setPaused(muted ? false : true);
              setChromeVisible(true);
            },
            onSwitchingChange: (switching) => {
              if (!isCurrentPlayback()) return;
              const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
              setSwitchingRoute((current) => switching ? route : current === route ? "" : current);
              if (switching) {
                setNormalPlaybackRoute("");
                setLoadingPulseRoute(route);
              }
            },
            onSwitchCompleted: () => {
              if (isCurrentPlayback()) runtime.reportPlaybackQuality?.("player_switch");
            },
            onPause: () => {
              if (!isCurrentPlayback()) return;
              setPaused(true);
              setNormalPlaybackRoute("");
              setLoadingPulseRoute((current) => current === `${dramaIdRef.current}:${episodeIdRef.current}` ? "" : current);
              progressReporterRef.current?.flush();
            },
            onEnded: () => {
              if (!isCurrentPlayback()) return;
              if (mountedPreviewRef.current) {
                setPaused(true);
                setNormalPlaybackRoute("");
                setLoadingPulseRoute("");
                const preview = lockedPreviewRef.current;
                if (preview) finishLockedPreview(playbackRouteRef.current, preview.seconds);
                return;
              }
              runtime.reportPlaybackComplete?.(dramaIdRef.current, episodeIdRef.current);
              // ENDED 可能早于最后一次 TIME_UPDATE；用官方内核最终快照覆盖旧节流位置。
              progressReporterRef.current?.flush(engineRef.current?.snapshot());
              setPaused(true);
              setNormalPlaybackRoute("");
              setLoadingPulseRoute("");
              setChromeVisible(true);
              if (entryAdDelayRef.current) {
                // 短首集播完后仍等详情计时和广告门禁，当前剧场放行后再自动切集。
                advanceAfterEntryAdRef.current = playbackRouteRef.current;
                return;
              }
              // 当前集正常结束时直接切到下一集；优先复用片尾刚刷新的权威验权结果。
              navigateByOffset(1);
            },
            onTimeUpdate: (snapshot) => {
              if (!isCurrentPlayback()) return;
              const restoringPosition = !!directResumeRef.current;
              restoreDirectPosition();
              // 未完成恢复时不把重建内核的零进度写回原有观看位置。
              if (directResumeRef.current) return;
              if (mountedPreviewRef.current) {
                const preview = lockedPreviewRef.current;
                // 试看媒体位置只约束服务端授权的片段范围；广告时间统一由详情页前台时钟决定。
                if (preview && snapshot.currentTime >= preview.seconds) finishLockedPreview(playbackRouteRef.current, preview.seconds);
                return;
              }
              if (!snapshot.paused && !snapshot.ended && snapshot.currentTime > 0) {
                refreshAdjacentPlayback();
              }
              // 官方 progress 插件消费同一内核时间；业务只保存位置，避免维护第二套进度状态。
              progressReporterRef.current?.report(restoringPosition ? mountingEngine.snapshot() : snapshot);
            },
            onError: (reason) => {
              if (!isCurrentPlayback()) return;
              setBufferingRoute("");
              setSwitchingRoute("");
              setLoadingPulseRoute("");
              setNormalPlaybackRoute("");
              setTransitionCoverRoute("");
              // SDK 具体错误由播放器适配器脱敏记录；页面只展示统一封装后的本地化提示。
              if (!recoverDirectAuthorization()) setPlaybackError(userMessage(reason, t("player.playbackError")));
              runtime.reportPlaybackQuality?.("player_error");
              setChromeVisible(true);
            },
          },
        );
        // SDK 可在 mount 兑现前回调错误或就绪；已被恢复流程释放的旧内核不能重新标记为挂载成功。
        if (!mounted || cancelled || engineRef.current !== mountingEngine) return;
        if (source.startTime !== undefined && previewBoundaryRef.current === boundary) previewBoundaryRef.current = undefined;
        mountedRef.current = true;
      } else {
        progressReporterRef.current?.flush();
        progressReporterRef.current?.clearTarget();
        sourceRef.current = source;
        selectProgressContext();
        try {
          await engineRef.current.switchSource(source);
        } catch (reason) {
          if (cancelled) return;
          engineRef.current?.destroy();
          engineRef.current = undefined;
          mountedRef.current = false;
          sourceRef.current = undefined;
          throw reason;
        }
        if (cancelled) return;
        // 切源完成前不接收进度，避免旧内核的迟到事件写到新一集。
        progressReporterRef.current?.setTarget(dramaId, episodeId);
      }
      engineRef.current?.setPlaybackRate?.(playbackRateRef.current);
      mountedResultRef.current = result;
      // mount/playNext 已经接管目标集，避免遮罩恢复 effect 再对同一内核补发一次播放。
      resumeAfterBlockRef.current = false;
      if (rewardResumeRouteRef.current === `${dramaId}:${episodeId}` && visibleRef.current &&
        !overlayRef.current && !runtime.isFullscreenAdActive?.()) {
        rewardResumeRouteRef.current = "";
        // 原生广告回程可能使官方 autoplay 保持暂停；仅在已重新验权的本集补发播放。
        if (engineRef.current?.snapshot().paused) {
          try { await engineRef.current.play(); }
          catch (reason) {
            logClientEvent("warn", "reward_playback_resume_failed", { error: safeErrorMessage(reason) });
            if (!cancelled && componentAliveRef.current) setPlaybackError(t("player.playbackError"));
          }
        }
      }
    };
    void mountOrSwitch().catch((reason: unknown) => {
      logClientEvent("error", "episode_player_initialize_failed", { error: safeErrorMessage(reason) });
      if (!cancelled && !recoverDirectAuthorization()) {
        setSwitchingRoute((current) => current === `${dramaId}:${episodeId}` ? "" : current);
        setTransitionCoverRoute((current) => current === `${dramaId}:${episodeId}` ? "" : current);
        setError(t("player.initializationError"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activePlayback, canPreparePlayback, dramaId, episodeId, finishLockedPreview, localLibrary, lockedPreview, navigateByOffset, refreshAdjacentPlayback, recoverDirectAuthorization, result, resultRoute, runtime, t, playbackGate.isBlocked]);

  useEffect(() => {
    componentAliveRef.current = true;
    return () => {
      componentAliveRef.current = false;
      progressReporterRef.current?.flush();
      progressReporterRef.current?.clearTarget();
      engineRef.current?.destroy();
      runtime.clearPlaybackEventContext?.();
    };
  }, []);

  useEffect(() => {
    let revision = 0;
    let disposed = false;
    const off = observeVisibility(window.TTMinis, (visible) => {
      visibleRef.current = visible;
      setPageVisible(visible);
      // 奖励刷新只在同一前台代次复用；校验后迟到的领奖回包不能复用切后台前已完成的许可恢复。
      rewardAccessRefreshRef.current = undefined;
      const ticket = ++revision;
      const engine = engineRef.current;
      if (!visible) {
        playbackCacheRef.current.clear();
        // 选集和倍速是软弹层；系统中断前只记录真实播放意图，不用弹层状态反推。
        resumeRef.current = !!engine && !engine.snapshot().paused && !engine.snapshot().ended && !runtime.isFullscreenAdActive?.();
        resumeAfterBlockRef.current = false;
        setResumeChecking(resumeRef.current);
        const pending = directResumeRef.current;
        if (pending?.route === `${dramaIdRef.current}:${episodeIdRef.current}` && pending.visit === episodeVisitRef.current) {
          pending.needsForegroundRefresh = true;
          ++resolveRequestRef.current;
          prepareDirectRecovery();
          return;
        }
        progressReporterRef.current?.flush();
        engine?.pause();
        return;
      }
      const shouldResume = resumeRef.current;
      resumeRef.current = false;
      const pending = directResumeRef.current;
      if (pending?.needsForegroundRefresh && pending.route === `${dramaIdRef.current}:${episodeIdRef.current}` && pending.visit === episodeVisitRef.current) {
        // 恢复内核已释放时也必须前台验权；暂停只决定 autoplay，不能绕过授权新鲜度。
        prepareDirectRecovery();
        setResumeChecking(false);
        void refreshDirectRecovery();
        return;
      }
      if (!shouldResume || !engine || runtime.isFullscreenAdActive?.()) { setResumeChecking(false); return; }
      const route = `${dramaIdRef.current}:${episodeIdRef.current}`;
      // 回前台重新验权，旧账号、旧路由、后台迟到结果均不能恢复播放。
      void runtime.api.resolvePlay(dramaIdRef.current, episodeIdRef.current).then(async (resolved) => {
        if (disposed || !componentAliveRef.current || ticket !== revision || !visibleRef.current || route !== `${dramaIdRef.current}:${episodeIdRef.current}` || engine !== engineRef.current) return;
        setResumeChecking(false);
        const authorized = resolved.status === "playable" ? resolved.playback
          : lockedPreviewRef.current && isAccessRequired(resolved) ? resolved.entryPreview?.playback : undefined;
        if (!authorized || authorized.provider !== sourceRef.current?.provider || authorized.vid !== sourceRef.current?.vid ||
          authorized.albumId !== sourceRef.current?.albumId || authorized.episodeId !== sourceRef.current?.episodeId ||
          (resolved.status === "playable") === mountedPreviewRef.current) {
          // 直接安装这次权威结果，禁止再次读取二十秒缓存中的旧许可。
          ++resolveRequestRef.current;
          runtime.invalidatePlayback?.();
          playbackCacheRef.current.clear();
          resultDirectoryRevisionRef.current = directoryRevisionRef.current;
          setResult(resolved);
          setResultRoute(route);
          setLoading(false);
          setError(resolved.status === "unavailable" ? t("player.openError") : "");
          if (authorized) {
            resumeAfterBlockRef.current = true;
            firstFrameRouteRef.current = "";
            setFirstFrameRoute("");
            setTransitionPoster({ episodeId: episodeIdRef.current, url: authorized.posterUrl || "" });
          }
          return;
        }
        // 验权和门禁重查并行；只有二者都确认后，恢复原来的播放意图。
        resumeAfterBlockRef.current = true;
        if (playbackBlockedRef.current || playbackGate.isBlocked() || runtime.isFullscreenAdActive?.()) return;
        resumeAfterBlockRef.current = false;
        await engine.play();
      }).catch((reason) => {
        logClientEvent("warn", "playback_resume_failed", { error: safeErrorMessage(reason) });
        if (!disposed && componentAliveRef.current && ticket === revision) { setResumeChecking(false); setPlaybackError(t("player.playbackError")); }
      });
    });
    return () => { disposed = true; revision += 1; off(); };
  }, [runtime, prepareDirectRecovery, refreshDirectRecovery, playbackGate.isBlocked]);

  useEffect(() => {
    if (entryAdDelay || !paused || loading || error || playbackError || adRunning || drawerOpen || result?.status !== "playable") return;
    let active = true;
    const show = () => void runtime.showInterstitialIfEligible?.(() => active && visibleRef.current && !entryAdDelayRef.current && !overlayRef.current && playedRouteRef.current === `${dramaId}:${episodeId}` && !!engineRef.current?.snapshot().paused && !engineRef.current?.snapshot().ended, "pause_interstitial");
    const first = window.setTimeout(show, 2_000);
    const timer = window.setInterval(show, 30_000);
    return () => { active = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [paused, loading, error, playbackError, adRunning, drawerOpen, result, dramaId, episodeId, runtime, entryAdDelay]);

  const offers = isAccessRequired(result) ? availableOffers(result).filter((offer) => offer.kind === "rewarded_episode") : [];

  const unlockEpisode = useCallback(async (selectedOffer?: AccessOffer, userInitiated = false) => {
    if (entryAdDelayRef.current || playbackGate.isBlocked() || !isAccessRequired(result) || loading || resultRoute !== `${dramaId}:${episodeId}` || unlockBusyRef.current || !visibleRef.current) return;
    // 同步占用，阻止自动 effect 与用户点击在 React 更新前启动两次广告。
    unlockBusyRef.current = true;
    // 新广告开始新的领取周期；没有订阅能力的调用方也不能复用上次结果。
    rewardAccessRefreshRef.current = undefined;
    setAutoUnlockAttempted(true);
    const visit = episodeVisitRef.current;
    const isCurrentVisit = () => componentAliveRef.current && visit === episodeVisitRef.current &&
      dramaIdRef.current === dramaId && episodeIdRef.current === episodeId;
    setAdRunning(true);
    setError("");
    try {
      if (runtime.hasPendingAdClaim?.()) {
        await runtime.retryPendingAdClaims();
        if (runtime.hasPendingAdClaim()) throw new Error(t("player.rewardError"));
        // 补领成功先刷新权益；不使用本次点击前的锁定状态再次播广告。
        if (isCurrentVisit()) await refreshRewardAccess(true);
        return;
      }
      const offer = selectedOffer ?? result.offer;
      let claimInput: ReturnType<typeof createRewardClaim>;
      let intent = captureAdIntent(() => isCurrentVisit() && !playbackGate.isBlocked(), userInitiated);
      while (true) {
        // 原生广告返回与门禁重查可交错；下一条广告必须等待当前主体重新放行。
        if (!await playbackGate.waitUntilReady() || !isCurrentVisit() || !visibleRef.current) return;
        // 提前关闭后只有开启提示的规则才显示倒计时；重看使用新 ClaimID，不复用未完成广告。
        claimInput = createRewardClaim(offer, dramaId, episodeId);
        const adResult = await runtime.showRewardedAd(claimInput.adUnitId, claimInput, intent);
        if (!isCurrentVisit()) return;
        if (adResult.status === "completed") break;
        if (adResult.status === "cancelled" && offer.promptOnIncomplete) {
          setAdRunning(false);
          if (await incompleteAd.ask(offer.incompleteAdCountdownSeconds, offer.incompleteAdDisplayCountdownSeconds) && isCurrentVisit() && visibleRef.current) {
            setAdRunning(true);
            intent = captureAdIntent(() => isCurrentVisit() && !playbackGate.isBlocked());
            continue;
          }
          return;
        }
        if (adResult.status === "failed") setError(t(adResult.reason === "client_outdated" ? "runtime.rewardedAdUnavailable" : "runtime.rewardedAdFailed"));
        if (adResult.status === "unknown") setError(t("runtime.rewardedAdPending"));
        if (adResult.status === "unsupported") setError(t("player.adUnavailable"));
        return;
      }
      const adClosedAt = performance.now();
      const claim = await runtime.claimReward(claimInput);
      logClientEvent("info", "episode_ad_return_claim_completed", { elapsedMs: performance.now() - adClosedAt });
      if (!claim.unlocked) throw new Error(t("player.rewardError"));
      if (isCurrentVisit()) {
        rewardResumeRouteRef.current = `${dramaId}:${episodeId}`;
        // 优先复用本次结算的有效许可；旧响应缺省或许可失效时单独回源验权，保留目录与下一集提示。
        // 暂停准备与下一广告提示并行，遮罩只阻止播放，不阻止已经授权的媒体准备。
        const currentPlaybackReady = applyRewardPlayback(claim.playback, claim.drama) ? Promise.resolve() : refreshRewardAccess(true, claim.drama);
        if (claim.nextAd?.dramaId === dramaId) {
          await autoUnlock.run(claim.nextAd, isCurrentVisit, () => visibleRef.current, incompleteAd.ask);
        }
        if (isCurrentVisit()) {
          await currentPlaybackReady;
        }
      }
    } catch (reason) {
      logClientEvent("error", "episode_unlock_failed", { error: safeErrorMessage(reason) });
      if (isCurrentVisit()) {
        setError(userMessage(reason, t("player.unlockError")));
      }
    } finally {
      unlockBusyRef.current = false;
      if (componentAliveRef.current) {
        // 广告回程先恢复完整播放控件，随后由正常的三秒定时器自动隐藏。
        setChromeVisible(true);
        setAdRunning(false);
      }
    }
  }, [result, loading, resultRoute, dramaId, episodeId, runtime, refreshRewardAccess, applyRewardPlayback, autoUnlock.run, incompleteAd.ask, playbackGate.isBlocked, playbackGate.waitUntilReady]);

  useEffect(() => {
    if (entryAdDelay || playbackGate.blocked || !isAccessRequired(result) || resultRoute !== `${dramaId}:${episodeId}` || loading || adRunning || autoUnlockAttempted || !pageVisible) return;
    const offer = availableOffers(result).find(candidate => candidate.kind === "rewarded_episode");
    if (!offer) return;
    // 进入锁定集后直接拉起配置的激励广告；失败或取消后才显示手动重试入口。
    void unlockEpisode(offer);
  }, [adRunning, autoUnlockAttempted, dramaId, episodeId, loading, pageVisible, result, resultRoute, unlockEpisode, playbackGate.blocked, entryAdDelay]);

  const currentEpisode = detail?.episodes.find((item) => item.id === episodeId);
  const sharePayload = useMemo<SharePayload | undefined>(() => {
    if (!detail || !currentEpisode || !dramaId || !episodeId) return undefined;
    const candidateImage = currentEpisode.posterUrl || detail.coverUrl;
    let imageUrl: string | undefined;
    try {
      const parsed = new URL(candidateImage);
      if (parsed.protocol === "https:") imageUrl = parsed.toString();
    } catch {
      // TikTok 要求使用公开图片 URL；没有图片时仍可分享。
    }
    return {
      title: `${detail.title} · ${t("drama.episode", { number: currentEpisode.number })}`,
      desc: currentEpisode.description.trim() || detail.description || undefined,
      imageUrl,
      // 官方锚点使用平台剧集 ID 预热启动；业务 ID 仍用于服务端确认目标与逐集验权。
      query: {
        dramaId: String(dramaId), episodeId: String(episodeId),
        ...(resultRoute === `${dramaId}:${episodeId}` && result?.status === "playable"
          ? (result.playback.provider === "byteplus_web" ? {} : { tt_album_id: result.playback.albumId, tt_episode_id: result.playback.episodeId })
          : {}),
      },
    };
  }, [detail, dramaId, episodeId, currentEpisode, result, resultRoute, t]);

  useEffect(() => {
    if (!sharePayload || !runtime.registerShare) return;
    // 官方回调只确认分享资料已配置，不能把它显示为用户已完成分享。
    return runtime.registerShare(sharePayload, () => undefined);
  }, [runtime, sharePayload]);

  const currentEpisodeLabel = currentEpisode
    ? t("drama.episode", { number: currentEpisode.number })
    : "";
  const episodeProgressLabel = currentEpisode && detail
    ? t("player.episodeProgress", {
        current: currentEpisode.number,
        total: detail.episodeCount,
      })
    : "";
  const currentEpisodeTitle =
    currentEpisode?.title.trim() !== currentEpisodeLabel
      ? currentEpisode?.title.trim()
      : "";
  const currentIndex =
    detail?.episodes.findIndex((item) => item.id === episodeId) ?? -1;
  const openEpisodeDrawer = () => {
    if (blockingOverlay || entryAdDelay) return;
    setDrawerOpen(true);
  };

  useEffect(() => {
    setDescriptionExpanded(false);
  }, [episodeId]);

  const visibleError = error || playbackError;
  const shouldAutoHideChrome =
    !!activePlayback &&
    firstFrameRoute === `${dramaId}:${episodeId}` &&
    switchingRoute !== `${dramaId}:${episodeId}` &&
    bufferingRoute !== `${dramaId}:${episodeId}` &&
    pageVisible &&
    !blockingOverlay &&
    !paused &&
    !drawerOpen &&
    !loading &&
    !visibleError &&
    chromeInteraction === "none";
  const supportsEpisodeSwipe =
    (result?.status === "playable" || isAccessRequired(result)) && switchingRoute !== `${dramaId}:${episodeId}` && !blockingOverlay && !entryAdDelay;
  // 海报不承载播放授权；锁定集也展示首图，媒体仍由 resolvePlay 严格控制。
  const previewableEpisodeIds = useMemo(
    () => new Set((detail?.episodes ?? []).map((episode) => episode.id)),
    [detail],
  );
  const clearChromeTimer = useCallback(() => {
    if (chromeTimerRef.current !== undefined) {
      window.clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = undefined;
    }
  }, []);

  const revealChrome = useCallback(() => {
    clearChromeTimer();
    setChromeVisible(true);
    if (shouldAutoHideChrome) {
      chromeTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
        chromeTimerRef.current = undefined;
      }, PLAYER_CHROME_HIDE_DELAY_MS);
    }
  }, [clearChromeTimer, shouldAutoHideChrome]);

  useEffect(() => {
    if (chromeInteraction !== "none") {
      clearChromeTimer();
      setChromeVisible(true);
    } else if (shouldAutoHideChrome) revealChrome();
    else if (paused && !playedRouteRef.current) {
      // 首次自动播放尚未确认时不展示控制层，避免初始 paused 占位状态闪成暂停态。
      clearChromeTimer();
      setChromeVisible(false);
    } else {
      clearChromeTimer();
      setChromeVisible(true);
    }
    return clearChromeTimer;
    // 正常播放确认可能先于首帧，须重新显示控制层；不能只等待首帧引起自动隐藏条件变化。
  }, [chromeInteraction, clearChromeTimer, revealChrome, shouldAutoHideChrome, normalPlaybackRoute, paused]);

  const onStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      !activePlayback ||
      isPlayerInteractiveTarget(event.target)
    ) {
      return;
    }
    if (!chromeVisible) {
      revealChrome();
      return;
    }
    if (paused) {
      if (directResumeRef.current) directResumeRef.current.shouldPlay = true;
      // 只在官方播放器确认 onPlay 后更新状态；避免播放请求失败时把界面误标为播放中。
      void engineRef.current?.play().catch((reason) => {
        logClientEvent("warn", "player_stage_resume_failed", { error: safeErrorMessage(reason) });
        setPlaybackError(t("player.playbackError"));
        setChromeVisible(true);
      });
      return;
    }
    if (normalPlaybackRoute === `${dramaId}:${episodeId}` && !paused) {
      clearChromeTimer();
      if (directResumeRef.current) directResumeRef.current.shouldPlay = false;
      engineRef.current?.pause();
      setChromeVisible(true);
    }
  };

  const advancePlaybackRate = () => {
    const currentIndex = PLAYBACK_RATES.findIndex(rate => rate === playbackRateRef.current);
    const nextRate = PLAYBACK_RATES[(currentIndex + 1 + PLAYBACK_RATES.length) % PLAYBACK_RATES.length];
    playbackRateRef.current = nextRate;
    engineRef.current?.setPlaybackRate?.(nextRate);
    setPlaybackRate(nextRate);
    revealChrome();
  };
  // 长按只临时覆盖播放器内核，松开后恢复按钮选择的常规倍速。
  const startTemporarySpeed = () => {
    if (temporarySpeedRef.current) return;
    temporarySpeedRef.current = true;
    clearChromeTimer();
    setChromeInteraction("speeding");
    setChromeVisible(true);
    // 临时速度不更新整页 React 状态，避免 Swiper 和播放器容器因长按重新渲染。
    if (playbackRateRef.current !== 2) engineRef.current?.setPlaybackRate?.(2);
  };
  const endTemporarySpeed = () => {
    if (!temporarySpeedRef.current) return;
    temporarySpeedRef.current = false;
    setChromeInteraction("none");
    setChromeVisible(true);
    engineRef.current?.setPlaybackRate?.(playbackRateRef.current);
  };
  const switching = switchingRoute === `${dramaId}:${episodeId}`;
  const awaitingEntryClip = !!lockedPreview && !lockedPreview.playback;
  const mediaLoading = pageVisible && !blockingOverlay && !error && !playbackError &&
    (awaitingEntryClip || (!!activePlayback && loadingPulseRoute === renderedRoute));
  const cachedCoverUrl = cachedPlaybackCover(runtime, dramaId, episodeId);
  const transitionPosterUrl = entryRouteRef.current === renderedRoute && entryCoverRef.current
    ? entryCoverRef.current
    : transitionPoster?.episodeId === episodeId && transitionPoster.url
      ? transitionPoster.url
      : currentEpisode?.posterUrl || detail?.coverUrl || cachedCoverUrl;
  const awaitingPlayableFrame = awaitingEntryClip || (!!activePlayback && firstFrameRoute !== renderedRoute);
  const awaitingTransition = !error && !playbackError && (
    awaitingPlayableFrame ||
    (resultRoute !== renderedRoute && (
      (!mountedRef.current && loading) || transitionCoverRoute === renderedRoute
    ))
  );
  const showTransitionPoster = !!transitionPosterUrl && awaitingTransition;
  // 自动拉起失败或用户取消后再展示手动重试入口，避免广告前出现中间页。
  const showLockedFallback = isAccessRequired(result) && autoUnlockAttempted && (!adRunning || manualAdRetry);
  // VIP 只从首页圆形入口领取；锁定集仍按逐集奖励规则解锁。
  const lockedOffers = isAccessRequired(result) ? offers : [];
  const primaryLockedOffer = lockedOffers[0];
  const runLockedOffer = async (offer: AccessOffer) => {
    setManualAdRetry(true);
    try {
      await unlockEpisode(offer, true);
    } finally {
      setManualAdRetry(false);
    }
  };

  return (
    <main className={`app-shell theater-page player-page${drawerOpen ? " is-episode-drawer-open" : ""}${showLockedFallback ? " is-locked-fallback" : ""}${switching ? " is-switching" : ""}${mediaLoading ? " is-media-loading" : ""}${chromeInteraction === "speeding" ? " is-speeding" : chromeInteraction === "seeking" ? " is-seeking" : ""}`}>
      <div inert={adRunning || drawerOpen || !!autoUnlock.prompt || !!incompleteAd.prompt} className="theater-content" data-entry-ad-delay={entryAdDelay ? "" : undefined}>
      <VideoSwiper
        activeEpisodeId={episodeId}
        chromeVisible={chromeVisible}
        speeding={chromeInteraction === "speeding"}
        episodes={detail?.episodes ?? []}
        fallbackPosterUrl={detail?.coverUrl || cachedCoverUrl}
        previewableEpisodeIds={previewableEpisodeIds}
        onClick={onStageClick}
        longPressEnabled={result?.status === "playable" && !entryAdDelay && !paused && !loading && !switching && !overlayRef.current}
        onLongPressStart={startTemporarySpeed}
        onLongPressEnd={endTemporarySpeed}
        onEpisodeChange={selectEpisode}
        playerRootRef={rootRef}
        swipeEnabled={supportsEpisodeSwipe}
      >
        {showLockedFallback && isAccessRequired(result) && (
          <div
            className="locked-stage"
            style={{
              backgroundImage: `linear-gradient(to top, rgba(7,7,9,.92), rgba(7,7,9,.3)), url("${result.episode.posterUrl}")`,
            }}
          >
            <div className="locked-copy">
              <div className="locked-eyebrow">
                <span>{episodeProgressLabel}</span>
                <span className="locked-access-label">
                  <LockKeyhole size={12} aria-hidden="true" />
                  {t("player.lockedEpisode")}
                </span>
              </div>
              <h2>{t("player.continueStory")}</h2>
              <p>{t("player.rewardedEpisodeHint")}</p>
              {primaryLockedOffer && (
                <button
                  type="button"
                  data-testid="locked-ad-retry"
                  className="primary-command locked-ad-retry"
                  disabled={adRunning}
                  onClick={() => runLockedOffer(primaryLockedOffer)}
                >
                  {adRunning ? t("player.playingBreak") : t("player.watchToUnlock")}
                </button>
              )}
              {lockedOffers.slice(1).map((offer) => (
                <button
                  key={offer.offerId}
                  type="button"
                  className="locked-vip-command"
                  disabled={adRunning}
                  onClick={() => runLockedOffer(offer)}
                >
                  {adRunning ? t("player.playingBreak") : t("player.watchToUnlock")}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 首次入剧沿用首页同一张缩略图，切集沿用目标封面；都等实际首帧再撤。 */}
        {showTransitionPoster && (
            <img
              className="player-transition-poster"
              src={coverThumbnail(transitionPosterUrl, entryRouteRef.current === renderedRoute && entryCoverRef.current ? 480 : 720)}
              alt=""
              aria-hidden="true"
              fetchPriority="high"
              onError={(event) => {
                if (event.currentTarget.src !== transitionPosterUrl) event.currentTarget.src = transitionPosterUrl;
              }}
            />
        )}
        {autoplayBlocked && activePlayback && (
          <button type="button" className="player-autoplay-command" onClick={() => {
            engineRef.current?.setMuted?.(false);
            void engineRef.current?.play().then(() => {
              setAutoplayBlocked(false);
              setPlaybackError("");
            }).catch((reason) => {
              logClientEvent("warn", "player_user_resume_failed", { error: safeErrorMessage(reason) });
              setPlaybackError(t("player.playbackError"));
            });
          }}>
            <Play size={18} fill="currentColor" aria-hidden="true" />
            {t("player.tapToPlayWithSound")}
          </button>
        )}

        {detail && (
          <>
          <div className="player-bottom-controls player-chrome">
            <button
              type="button"
              className="episode-bar"
              onClick={openEpisodeDrawer}
              disabled={loading || !!entryAdDelay}
              aria-label={t("player.episodeSelector")}
            >
              <DramaIcon className="episode-bar-icon" />
              <span className="episode-bar-copy">
                <strong>{episodeProgressLabel}</strong>
              </span>
              <ChevronUpIcon className="episode-bar-chevron" />
            </button>
            {activePlayback && (
              <button
                type="button"
                className="playback-rate-button"
                disabled={!!entryAdDelay}
                onClick={() => {
                  if (blockingOverlay) return;
                  setDrawerOpen(false);
                  advancePlaybackRate();
                }}
                aria-label={t("player.playbackSpeed", { rate: `${playbackRate}x` })}
              >
                <span aria-hidden="true">{playbackRate}x</span>
              </button>
            )}
          </div>
          </>
        )}

        {activePlayback && (
          <>
            <section className="theater-copy player-chrome">
              <h1 className="eyebrow">{detail?.title}</h1>
              <p className="theater-episode-line">{episodeProgressLabel}{currentEpisodeTitle ? ` · ${currentEpisodeTitle}` : ""}</p>
              {currentEpisode?.description ? (
                <div className={`theater-description${descriptionExpanded ? " is-expanded" : ""}`}>
                  <p>{currentEpisode.description}</p>
                  <button
                    type="button"
                    aria-expanded={descriptionExpanded}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDescriptionExpanded((expanded) => !expanded);
                      revealChrome();
                    }}
                  >
                    {descriptionExpanded ? t("player.showLess") : t("player.showMore")}
                  </button>
                </div>
              ) : null}
            </section>
          </>
        )}

        <div className="episode-navigation-accessible">
          <button
            type="button"
            className="sr-only"
            disabled={!!entryAdDelay || currentIndex <= 0}
            onClick={() => navigateByOffset(-1)}
            aria-label={t("player.previousEpisode")}
            title={t("player.previousEpisode")}
          >
            {t("player.previousEpisode")}
          </button>
          <button
            type="button"
            className="sr-only"
            disabled={!!entryAdDelay || !detail || currentIndex >= detail.episodes.length - 1}
            onClick={() => navigateByOffset(1)}
            aria-label={t("player.nextEpisode")}
            title={t("player.nextEpisode")}
          >
            {t("player.nextEpisode")}
          </button>
        </div>

        {visibleError && (
          <div className="player-error" role="alert" aria-live="assertive">
            <span>{visibleError}</span>
            <button type="button" onClick={() => {
              if (retryBusyRef.current === resolveRequestRef.current || unlockBusyRef.current) return;
              directRecoveryRef.current = "";
              setAutoUnlockAttempted(false);
              const recovering = prepareDirectRecovery();
              if (!recovering) {
                // 用户明确重试形成新播放尝试；内部重新验权继续复用原尝试。
                requestAttemptRef.current = { route: `${dramaId}:${episodeId}`, reported: false };
                playbackCacheRef.current.clear();
                runtime.invalidatePlayback?.();
              }
              const retry = recovering ? refreshDirectRecovery() : resolveEpisode();
              const requestId = resolveRequestRef.current;
              retryBusyRef.current = requestId;
              // 迟到的旧请求只能释放自己的忙标记，不能解锁后来启动的手动重试。
              void retry.finally(() => { if (retryBusyRef.current === requestId) retryBusyRef.current = undefined; });
            }}>
              <RotateCcw size={16} aria-hidden="true" />
              {t("common.retry")}
            </button>
          </div>
        )}
      </VideoSwiper>

      {/* 返回入口固定在三屏滑动轨道外，切换上下集时仍留在屏幕顶部。 */}
      <div className={`player-topbar player-chrome${chromeVisible ? " chrome-visible" : ""}`}>
        <button
          type="button"
          className="player-back-button"
          onClick={returnHome}
          aria-label={t("common.back")}
          title={t("common.back")}
        >
          <ArrowLeft />
        </button>
      </div>

      </div>
      {drawerOpen && detail ? <EpisodeSheet drama={detail} episodeId={episodeId} vipActive={vipState.active} onClose={() => setDrawerOpen(false)} onSelect={selectEpisode} /> : null}
      {autoUnlock.prompt && <AutoUnlockDialog key={autoUnlock.prompt.episodeNumber} prompt={autoUnlock.prompt} visible={pageVisible && !playbackGate.blocked} />}
      {incompleteAd.prompt && <IncompleteAdDialog prompt={incompleteAd.prompt} visible={pageVisible && !playbackGate.blocked} />}
      {autoUnlock.notice && <p className="auto-unlock-notice" role="status">{autoUnlock.notice}</p>}
    </main>
  );
}
