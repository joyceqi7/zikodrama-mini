import { hasPlaybackLaunch } from "./runtime/launchRoute";
import { currentApplicationProfile } from "./config/applicationProfile";
import { productionTikTokMinisPlayerAdapter } from "./player/tiktokMinisPlayerAdapter";
import { createRuntime } from "./runtime/runtime";
import { logClientEvent, safeErrorMessage } from "./observability/clientLog";
import { installPreviewConsole } from "./observability/previewConsole";
import { preloadHomeCovers } from "./components/homeImagePreload";
import { startApplication } from "./runtime/startup";
import { installLeftEdgeGestureGuard } from "./platform/tiktok/leftEdgeGestureGuard";
import "./styles.css";
import "./official-ui.css";
import "./account-ui.css";

const entryStartedAt = performance.now();
logClientEvent("info", "app_entry_started", { stage: "page_script_start", elapsedMs: entryStartedAt });
if (import.meta.env.VITE_MINIS_PREVIEW_BUILD === "1") installPreviewConsole();
installLeftEdgeGestureGuard();

const legalPath = window.location.hash.replace(/^#/, "").replace(/\/$/, "");
const legalPage = legalPath === "/privacy" || legalPath === "/agreement";
const appName = currentApplicationProfile().name;
if (legalPage) document.title = legalPath === "/privacy" ? `${appName} Privacy Policy` : `${appName} Terms of Services`;
else document.title = appName;
const runtime = legalPage ? undefined : createRuntime(productionTikTokMinisPlayerAdapter);
const playbackLaunch = hasPlaybackLaunch(window.location.hash, window.location.search);
// 公开配置和宿主初始化并行，React 挂载后继续使用同一个配置请求。
void runtime?.prefetchAppConfig?.().catch(() => { /* 配置读取边界已记录实际错误，启动流程负责显示失败和重试。 */ });
// 尽早初始化宿主并保存生命周期信号，不等待登录或业务组件挂载。
if (runtime) void runtime.whenPlatformReady?.().catch(reason => logClientEvent("warn", "initial_lifecycle_unavailable", { error: safeErrorMessage(reason) }));
// 公开内容无需身份；先用本地快照发现封面，冷启动则在推荐返回时立即预热，不等待登录、目录或 React effect。
const homeEntry = (!legalPath || legalPath === "/") && !playbackLaunch;
const cachedHomeSections = homeEntry ? runtime?.getCachedHomeSections?.() : undefined;
if (cachedHomeSections) preloadHomeCovers(cachedHomeSections);
if (homeEntry) void runtime?.prefetchHome?.(preloadHomeCovers).catch(reason => logClientEvent("warn", "home_prefetch_failed", { error: safeErrorMessage(reason) }));
// 登录、投放目标决策和明确入口的播放器准备，与 React/App 模块下载并行。
const startup = runtime ? startApplication(runtime, playbackLaunch) : undefined;
/** mountPreparedApplication 将提前启动的 Runtime 交给 React；普通入口同时传入已下载的首页组件。 */
export function mountPreparedApplication(
  mountApplication: typeof import("./mountApplication").mountApplication,
  initialHomePage?: typeof import("./pages/square").SquarePage,
): void {
  // 仅表示 UI 模块可用，不把 render 提交当作页面首帧或视频正常播放。
  logClientEvent("info", "app_ui_module_ready", { elapsedMs: Math.max(0, performance.now() - entryStartedAt) });
  mountApplication(runtime, startup, initialHomePage);
}
