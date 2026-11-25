import type { TikTokMinisSDK } from "./types";
import type { AdLifecycleEvent, AdTimelinePoint } from "../../observability/adMetrics";
import { logClientEvent } from "../../observability/clientLog";
import { platformErrorMessage } from "./errors";

/** VisibilitySnapshot 是页面共享的可见性证据；unknown 不假装已收到宿主前台确认。 */
export interface VisibilitySnapshot {
  /** documentVisibility 是网页可见状态，包含 pagehide。 */
  documentVisibility: "visible" | "hidden";
  /** nativeVisibility 保留最近的原生信号，组件重挂载不会重置。 */
  nativeVisibility: "unknown" | "visible" | "hidden";
  /** prerendering 只表示浏览器明确提供的预渲染状态。 */
  prerendering: boolean;
  /** visible 合并网页、原生及浏览器预渲染门禁。 */
  visible: boolean;
  /** epoch 在可见性证据变化时递增，用于作废旧展示意图。 */
  epoch: number;
  /** foregroundEpoch 仅在真正恢复前台或首次原生前台确认时递增。 */
  foregroundEpoch: number;
}

let snapshot: VisibilitySnapshot | undefined;
let pageHidden = false;
let sdkBinding: TikTokMinisSDK | undefined;
let stopDocument: (() => void) | undefined;
let subscriptions: [string, string][] = [];
const listeners = new Set<(visible: boolean) => void>();
// 时序只保留最近八个信号，覆盖上限后由请求显式报告缺口。
const adLifecycleLimit = 8;
const adLifecycle: AdLifecycleEvent[] = [];
let adLifecycleCursor = 0;
const prerendering = () => (document as Document & { prerendering?: boolean }).prerendering === true;
const documentVisibility = () => document.visibilityState === "hidden" ? "hidden" as const : "visible" as const;

function update(change: Partial<VisibilitySnapshot>, source: AdLifecycleEvent["source"] = "document"): void {
  const previous = getVisibilitySnapshot();
  const next = { ...previous, ...change };
  next.visible = next.documentVisibility === "visible" && next.nativeVisibility !== "hidden" && !next.prerendering;
  const changed = previous.documentVisibility !== next.documentVisibility || previous.nativeVisibility !== next.nativeVisibility || previous.prerendering !== next.prerendering;
  if (changed) next.epoch += 1;
  const foreground = next.visible && (!previous.visible || previous.nativeVisibility === "unknown" && next.nativeVisibility === "visible");
  if (foreground) next.foregroundEpoch += 1;
  snapshot = next;
  // 重复宿主信号也有诊断价值，但不额外改变前台版本或通知业务监听。
  if (changed || source !== "document") {
    adLifecycleCursor += 1;
    adLifecycle.push({ ...captureAdTimelinePoint(), source });
    if (adLifecycle.length > adLifecycleLimit) adLifecycle.shift();
  }
  if (previous.visible !== next.visible || foreground) {
    for (const listener of [...listeners]) {
      // 订阅者同步处理期间若又收到新状态，停止传播已经过期的旧通知。
      if (snapshot?.epoch !== next.epoch) break;
      try { listener(next.visible); }
      catch (error) { logClientEvent("error", "lifecycle_listener_failed", { error: platformErrorMessage(error, "Lifecycle listener failed") }); }
    }
  }
}

/** getVisibilitySnapshot 读取共享证据，不通过 canIUse 或 document.visible 推断原生前台。 */
export function getVisibilitySnapshot(): VisibilitySnapshot {
  if (!snapshot) {
    const page = documentVisibility();
    const rendering = prerendering();
    snapshot = { documentVisibility: page, nativeVisibility: "unknown", prerendering: rendering, visible: page === "visible" && !rendering, epoch: 0, foregroundEpoch: 0 };
  }
  return snapshot;
}

/** captureAdTimelinePoint 同步读取网页状态和最后一次宿主信号，不更新业务门禁。 */
export function captureAdTimelinePoint(at = performance.now()): AdTimelinePoint {
  return {
    atMs: Math.round(at), documentVisibility: pageHidden ? "hidden" : documentVisibility(),
    nativeVisibility: getVisibilitySnapshot().nativeVisibility, prerendering: prerendering(),
  };
}

/** getAdLifecycleCursor 供 onClose 标记边界，同毫秒内也能按实际观察顺序切分。 */
export function getAdLifecycleCursor(): number {
  return adLifecycleCursor;
}

/** readAdLifecycleSince 返回关闭后已观察到的信号，溢出后明确标出不完整区间。 */
export function readAdLifecycleSince(cursor: number): { lifecycle: AdLifecycleEvent[]; lifecycleTruncated: boolean } {
  const start = cursor - (adLifecycleCursor - adLifecycle.length);
  return { lifecycle: adLifecycle.slice(Math.max(0, start)), lifecycleTruncated: start < 0 };
}

/** refreshVisibilitySnapshot 在展示前同步采样网页状态，覆盖 visibilitychange 尚未派发的窗口；原生证据和 pagehide 不会被网页 visible 覆盖。 */
export function refreshVisibilitySnapshot(): VisibilitySnapshot {
  update({ documentVisibility: pageHidden ? "hidden" : documentVisibility(), prerendering: prerendering() });
  return getVisibilitySnapshot();
}

/** ensureVisibilityTracking 在 SDK 初始化成功后安装一次；订阅比登录和业务组件更早，换 SDK 也不抹去已知后台。 */
export function ensureVisibilityTracking(sdk?: TikTokMinisSDK): void {
  getVisibilitySnapshot();
  if (!stopDocument) {
    const visibility = () => { refreshVisibilitySnapshot(); };
    const hide = () => { pageHidden = true; refreshVisibilitySnapshot(); };
    const show = () => { pageHidden = false; refreshVisibilitySnapshot(); };
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("prerenderingchange", visibility);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    stopDocument = () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("prerenderingchange", visibility);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }
  if (!sdk || sdkBinding === sdk) return;
  detachNative();
  sdkBinding = sdk;
  for (const event of ["minis.hide", "minis.show", "minis.destroy"] as const) {
    try {
      if (sdk.on) subscriptions.push([event, sdk.on(event, () => update({ nativeVisibility: event === "minis.show" ? "visible" : "hidden" }, event))]);
    } catch (error) { logClientEvent("warn", "lifecycle_subscribe_failed", { error: platformErrorMessage(error, "Lifecycle unavailable") }); }
  }
}

function detachNative(): void {
  for (const [event, id] of subscriptions) {
    try { sdkBinding?.off?.(event, id); }
    catch (error) { logClientEvent("warn", "lifecycle_cleanup_failed", { error: platformErrorMessage(error, "Lifecycle cleanup failed") }); }
  }
  subscriptions = [];
}

/** observeVisibility 只移除当前订阅者；最后一个组件卸载后仍保留页面生命周期证据。 */
export function observeVisibility(sdk: TikTokMinisSDK | undefined, listener: (visible: boolean) => void): () => void {
  // 公开首页可能先于官方 init 挂载；只安装网页监听，原生监听由就绪入口接管。
  ensureVisibilityTracking(window.__TIKTOK_MINIS_INITIALIZE__ && !window.__TIKTOK_MINIS_INITIALIZED__ ? undefined : sdk);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** disposeVisibilityTracking 仅在整个页面运行时销毁时调用；组件卸载和前后台切换不得清空证据。 */
export function disposeVisibilityTracking(): void {
  detachNative();
  stopDocument?.();
  stopDocument = undefined;
  sdkBinding = undefined;
  snapshot = undefined;
  pageHidden = false;
  listeners.clear();
  adLifecycle.length = 0;
  adLifecycleCursor += 1;
}
