import { hasPlaybackLaunch, readCampaignCover } from "./runtime/launchRoute";
import { getCampaignPreparation, subscribeCampaignPreparation } from "./runtime/campaignPreparation";
import { installImmersiveNavigation } from "./platform/tiktok/navigation";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { text as t } from "./copy";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { userMessage } from "./api/userMessage";
import { PlaybackLaunchPreview } from "./components/PlaybackLaunchPreview";
import { AccountHeader } from "./components/AccountHeader";
import { BottomNav } from "./components/BottomNav";
import { logClientEvent, safeErrorMessage } from "./observability/clientLog";
import { text } from "./copy";
import { AgreementPage, PrivacyPolicyPage } from "./pages/LegalPage";
import type { SquareFilters, SquarePage as SquarePageComponent } from "./pages/square";
import { RuntimeContext } from "./runtime/RuntimeContext";
import { createRuntime, type Runtime } from "./runtime/runtime";
import { playbackEntryPath } from "./domain/resumePlayback";
import { loadTheaterModule } from "./runtime/theaterModule";
import { preconnectMediaCDN } from "./config/mediaNetwork";
import { startApplication, type ApplicationStartup } from "./runtime/startup";
import type { DramaSummary } from "./domain/types";

// 所有业务页面按路由加载，投放直达剧场时不下载首页及轮播依赖。
const SquarePage = lazy(() => import("./pages/square").then(module => ({ default: module.SquarePage })));
const TheaterPage = lazy(() => loadTheaterModule().then(module => ({ default: module.TheaterPage })));
const LibraryPage = lazy(() => import("./pages/LibraryPage").then(module => ({ default: module.LibraryPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then(module => ({ default: module.ProfilePage })));

// 个人页代码在身份确认后提前加载；用户立刻切 tab 时仍显示对应页的导航壳。
function preloadAccountPages(): void {
  void import("./pages/LibraryPage").catch(reason => logClientEvent("warn", "history_module_preload_failed", { error: safeErrorMessage(reason) }));
  void import("./pages/ProfilePage").catch(reason => logClientEvent("warn", "profile_module_preload_failed", { error: safeErrorMessage(reason) }));
}

/** App 并行加载公开目录与静默身份，个人页面只在身份完整安装后挂载。 */
export function App({ runtime: suppliedRuntime, startup: suppliedStartup, initialHomePage }: {
  /** runtime 是当前应用的身份和播放容器；未提供时沿用独立挂载入口。 */
  runtime?: Runtime;
  /** startup 复用同一容器在 React 加载前发起的任务，不能跨 Runtime 放行身份。 */
  startup?: ApplicationStartup;
  /** initialHomePage 在普通入口已加载，可在首次 React 提交时直接挂载。 */
  initialHomePage?: typeof SquarePageComponent;
} = {}) {
  const runtime = useMemo(
    () => suppliedRuntime || createRuntime(),
    [suppliedRuntime],
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [homeFilters, setHomeFilters] = useState<SquareFilters>({ tag: "" });
  const navigationChosen = useRef(false);
  const pendingHomeDrama = useRef<DramaSummary | undefined>(undefined);
  // 同一轮任务在 StrictMode effect 重放及已完成的提前启动后仍保留；只有明确重试才开启下一轮。
  const startupAttempt = useRef<{ runtime: Runtime; attempt: number; startup: ApplicationStartup }>(undefined);
  const playbackPreparation = useRef<{ runtime: Runtime; attempt: number }>(undefined);
  const preparePlayback = useCallback(() => {
    const previous = playbackPreparation.current;
    if (!runtime.preparePlayback || (previous?.runtime === runtime && previous.attempt === bootstrapAttempt)) return;
    const preparation = { runtime, attempt: bootstrapAttempt };
    playbackPreparation.current = preparation;
    void runtime.preparePlayback().catch(reason => {
      if (playbackPreparation.current === preparation) playbackPreparation.current = undefined;
      logClientEvent("warn", "player_prepare_failed", { error: safeErrorMessage(reason) });
    });
  }, [runtime, bootstrapAttempt]);
  // 身份安装失败是全局状态，不能只留在某个 API 调用的 catch 中让页面永久不可用。
  const sessionSubscription = useMemo(() => ({
    subscribe: (listener: () => void) => runtime.subscribeSessionState?.(listener) || (() => undefined),
    getSnapshot: () => runtime.getSessionState?.() || "ready",
  }), [runtime]);
  const sessionState = useSyncExternalStore(
    sessionSubscription.subscribe,
    sessionSubscription.getSnapshot,
    sessionSubscription.getSnapshot,
  );
  // 成功换主体也必须释放旧页面并重新验权；复用启动配置通知，不再建立身份状态容器。
  const subjectSubscription = useMemo(() => ({
    subscribe: (listener: () => void) => runtime.subscribeAdExperience(listener),
    getSnapshot: () => runtime.getSessionSubjectKey?.() || "",
  }), [runtime]);
  const subjectKey = useSyncExternalStore(
    subjectSubscription.subscribe,
    subjectSubscription.getSnapshot,
    subjectSubscription.getSnapshot,
  );
  useEffect(() => {
    if (!runtime.whenPlatformReady) return installImmersiveNavigation(window.TTMinis);
    let active = true;
    let dispose: (() => void) | undefined;
    void runtime.whenPlatformReady().then(() => {
      if (active) dispose = installImmersiveNavigation(window.TTMinis);
    }).catch(reason => logClientEvent("warn", "navigation_sdk_unavailable", { error: safeErrorMessage(reason) }));
    return () => { active = false; dispose?.(); };
  }, [runtime, bootstrapAttempt]);
  useEffect(() => {
    let active = true;
    let sdk: typeof window.TTMinis;
    const enableProtection = () => {
      if (!active || !window.TTMinis?.disableCapture) return;
      sdk = window.TTMinis;
      try {
        sdk.disableCapture?.((result) => {
          if (!result?.isSuccess) logClientEvent("warn", "capture_protection_unavailable", { error: "disable_capture_failed" });
        });
      } catch (reason) {
        logClientEvent("warn", "capture_protection_failed", { error: safeErrorMessage(reason) });
      }
    };
    if (runtime.whenPlatformReady) {
      void runtime.whenPlatformReady().then(enableProtection).catch(reason => {
        logClientEvent("warn", "capture_protection_sdk_unavailable", { error: safeErrorMessage(reason) });
      });
    } else {
      enableProtection();
    }
    return () => {
      active = false;
      try {
        sdk?.enableCapture?.(result => {
          if (!result?.isSuccess) logClientEvent("warn", "capture_protection_release_failed", { error: "enable_capture_failed" });
        });
      } catch (reason) {
        logClientEvent("warn", "capture_protection_release_failed", { error: safeErrorMessage(reason) });
      }
    };
  }, [runtime, bootstrapAttempt]);
  const requiresRecovery = sessionState === "recovery_required";

  useEffect(() => {
    if (status === "ready" && !requiresRecovery) preloadAccountPages();
  }, [status, requiresRecovery]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setMessage("");
    const playbackLaunch = hasPlaybackLaunch(window.location.hash, window.location.search);
    let current = startupAttempt.current;
    if (current?.runtime !== runtime || current.attempt !== bootstrapAttempt) {
      // 提前失败也必须先交给界面；不能因挂载时已封闭身份而自动恢复或重复投放决策。
      const startup = bootstrapAttempt === 0 && suppliedStartup?.runtime === runtime
        ? suppliedStartup
        : startApplication(runtime, playbackLaunch, bootstrapAttempt > 0);
      current = { runtime, attempt: bootstrapAttempt, startup };
      startupAttempt.current = current;
    }
    const initialize = current.startup.bootstrap;
    let prepareTimer: number | undefined;
    if (playbackLaunch) {
      // 提前准备已由启动边界记录失败；本轮只消费一次，避免 StrictMode 或路由交接隐式重试 SDK。
      if (current.startup.playback) playbackPreparation.current = { runtime, attempt: bootstrapAttempt };
      else preparePlayback();
    } else {
      // 自然入口先提供列表和封面；用户点剧时会提前触发同一准备任务。
      prepareTimer = window.setTimeout(preparePlayback, 1_200);
    }
    initialize
      .then(() => {
        if (cancelled) return;
        const pending = pendingHomeDrama.current;
        if (pending) {
          pendingHomeDrama.current = undefined;
          window.location.hash = playbackEntryPath(runtime.localLibrary.history(), pending);
        }
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setMessage(userMessage(reason, text("app.initializeError")));
          setStatus("error");
        }
      });
    return () => { cancelled = true; if (prepareTimer !== undefined) window.clearTimeout(prepareTimer); };
  }, [runtime, bootstrapAttempt, preparePlayback, suppliedStartup]);

  let homeSession: NonNullable<ComponentProps<typeof SquarePage>>["session"];
  if (runtime.loadPublicCatalog && (status !== "ready" || requiresRecovery)) {
    const retry = () => {
      setStatus("loading");
      setBootstrapAttempt((value) => value + 1);
    };
    homeSession = {
      signingIn: status === "loading",
      error: status === "error" ? message : requiresRecovery ? t("apiErrors.sessionUnavailable") : "",
      onRetry: retry,
      onNavigate: (path, drama) => {
        navigationChosen.current = true;
        pendingHomeDrama.current = drama;
        if (status === "loading" && path.startsWith("/watch/")) {
          // 键盘或辅助技术直接点选时也可在身份安装期间建连。
          preconnectMediaCDN();
          preparePlayback();
        }
        window.location.hash = path;
        if (path !== "/" && status !== "loading") retry();
      },
    };
  }

  if (!runtime.loadPublicCatalog && status === "loading") {
    // 兼容入口仍等待身份；投放和播放深链可以提前展示已有目标封面。
    if (hasPlaybackLaunch(window.location.hash, window.location.search)) return (
      <PlaybackLaunchPreview runtime={runtime} campaignCover={readCampaignCover(window.location.hash, window.location.search)} />
    );
    return null;
  }
  if (!runtime.loadPublicCatalog && (status === "error" || requiresRecovery)) {
    return (
      <div className="startup-screen error" role="alert">
        <span className="startup-mark">!</span>
        <strong>{t("app.unableToStart")}</strong>
        <small>{status === "error" ? message : t("apiErrors.sessionUnavailable")}</small>
        <button
          type="button"
          className="primary-command"
          onClick={() => {
            setStatus("loading");
            setBootstrapAttempt((value) => value + 1);
          }}
        >
          <RotateCcw size={17} aria-hidden="true" />
          {t("common.retry")}
        </button>
      </div>
    );
  }

  return (
    <RuntimeContext.Provider value={runtime}>
      <HashRouter>
        <ApplicationRoutes runtime={runtime} subjectKey={subjectKey} initialHomePage={initialHomePage} homeSession={homeSession} homeFilters={homeFilters}
          onHomeFiltersChange={setHomeFilters} skipLaunchTarget={navigationChosen.current} preparePlayback={preparePlayback} />
      </HashRouter>
    </RuntimeContext.Provider>
  );
}

function ApplicationRoutes({ runtime, subjectKey, initialHomePage, homeSession, homeFilters, onHomeFiltersChange, skipLaunchTarget, preparePlayback }: {
  runtime: Runtime;
  /** subjectKey 只重建个人页面；公开首页保留已加载的推荐与分页。 */
  subjectKey: string;
  /** initialHomePage 只在直接打开首页时传入；从剧场返回时仍按需下载。 */
  initialHomePage?: typeof SquarePageComponent;
  /** homeSession 存在时封闭个人路由，首页仍展示公开内容。 */
  homeSession?: NonNullable<ComponentProps<typeof SquarePage>>["session"];
  homeFilters: SquareFilters;
  onHomeFiltersChange: (filters: SquareFilters) => void;
  skipLaunchTarget: boolean;
  /** preparePlayback 进入剧场时即时准备当前应用的播放器构造器。 */
  preparePlayback(): void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  useEffect(() => {
    const enteringPlayback = previousPath.current !== pathname && pathname.startsWith("/watch/");
    previousPath.current = pathname;
    if (enteringPlayback) preparePlayback();
  }, [pathname, preparePlayback]);
  const launchHandled = useRef(false);
  const rootLaunch =
    !window.location.hash ||
    window.location.hash === "#/" ||
    window.location.hash === "#";
  const launchTarget = rootLaunch && !skipLaunchTarget ? runtime.getLaunchTarget() : undefined;
  useEffect(() => {
    if (homeSession || launchHandled.current) return;
    launchHandled.current = true;
    if (!launchTarget) return;
    navigate(
      `/watch/${encodeURIComponent(launchTarget.dramaId)}/${encodeURIComponent(launchTarget.episodeId)}`,
      { replace: true },
    );
  }, [homeSession, launchTarget, navigate]);

  const accountWaiting = <main className="account-page"><AccountHeader /><BottomNav /></main>;
  const prepared = useSyncExternalStore(subscribeCampaignPreparation, getCampaignPreparation);
  const entryCover = rootLaunch && !skipLaunchTarget
    ? (prepared?.search === window.location.search ? prepared.cover : readCampaignCover(window.location.hash, window.location.search))
    : undefined;
  // 正式目标确认后只沿用匹配的展示图；会话和服务端仍独立决定是否放行、进入哪一集。
  const matchingCover = entryCover && (!launchTarget ||
    (launchTarget.dramaId === entryCover.dramaId && launchTarget.episodeId === entryCover.episodeId)) ? entryCover : undefined;
  const playbackWaiting = <PlaybackLaunchPreview runtime={runtime} error={homeSession?.error} onRetry={homeSession?.onRetry}
    campaignCover={matchingCover} identityReady={!homeSession} deferCoverLookup={!!runtime.resolvePlaybackEntry} />;
  // 登录与目标解析期间保留播放加载态；拿到目标到路由切换之间也不能挂载首页并发起首页请求。
  const waitingForLaunch = Boolean(!homeSession && !launchHandled.current && launchTarget)
    || Boolean(homeSession && !skipLaunchTarget && hasPlaybackLaunch(window.location.hash, window.location.search));
  const HomePage = initialHomePage || SquarePage;
  const home = <Suspense fallback={<main className="app-shell square-page" aria-busy="true"><BottomNav /></main>}>
    <HomePage filters={homeFilters} onFiltersChange={onHomeFiltersChange} session={homeSession} subjectKey={subjectKey} />
  </Suspense>;
  const deferred = (page: ReactNode) => <Suspense fallback={accountWaiting}>{page}</Suspense>;

  return (
    <Routes>
      <Route path="/" element={waitingForLaunch ? playbackWaiting : home} />
      <Route path="/watch/:dramaId/:episodeId" element={homeSession ? playbackWaiting : <Suspense fallback={playbackWaiting}><TheaterPage key={subjectKey} /></Suspense>} />
      <Route path="/library" element={homeSession ? home : deferred(<LibraryPage key={subjectKey} />)} />
      <Route path="/history" element={<Navigate to="/library" replace />} />
      <Route path="/profile" element={homeSession ? home : deferred(<ProfilePage key={subjectKey} />)} />
      <Route path="/privacy" element={<PrivacyPolicyPage />} />
      <Route path="/agreement" element={<AgreementPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
