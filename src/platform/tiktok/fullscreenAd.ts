import type { AdObserver, AdObservation, AdMetricKind, AdFailureFacts, AdReleaseReason } from "../../observability/adMetrics";
import { adPolicy } from "../../config/adPolicy";
import { logClientEvent } from "../../observability/clientLog";
import { createMetricID } from "../../observability/metrics";
import { isAdActiveConflict, isAdContainerUnavailable, isAdForegroundRejected, platformErrorCodes, platformErrorMessage, platformInnerErrorMessage } from "./errors";
import { captureAdTimelinePoint, ensureVisibilityTracking, getAdLifecycleCursor, getVisibilitySnapshot, readAdLifecycleSince, refreshVisibilitySnapshot, observeVisibility } from "./lifecycle";
import { captureAdIntent, type AdIntent } from "./adIntent";
import type { RewardedAdCloseResult, RewardedVideoAd, TikTokMinisSDK } from "./types";

/** FullscreenAdResult 区分原生确认结果与本地等待超时；unknown 不允许发奖或自动重拉。 */
export type FullscreenAdResult =
  | { /** status 表示 SDK 已明确确认完整观看。 */ status: "completed" }
  | { /** status 表示原生已关闭且没有激励完播证明，不产生奖励。 */ status: "cancelled" }
  | { /** status 表示环境缺少已确认支持的官方广告能力。 */ status: "unsupported" }
  | {
    /** status 表示调用明确失败或当前处于客户端退避期。 */
    status: "failed";
    /** message 仅供内部诊断，页面必须映射为固定提示。 */
    message?: string;
    /** reason 区分可恢复的前台门禁与 SDK 失败，不能据此发奖。 */
    reason?: "not_visible" | "stale_intent" | "container_unavailable" | "container_suspended" | "active_conflict" | "cooldown" | "client_outdated";
    /** retryable 仅在宿主明确拒绝且本次从未展示、已释放原生实例时为 true；普通错误与未知结果均不具备恢复资格。 */
    retryable?: true;
  }
  | { /** status 表示本地等待结束但原生请求仍未确认，不能据此解除互斥。 */ status: "unknown" };

// 请求隔离与页面等待分开：未知结果不能重拉广告，也不能永久阻塞普通视频恢复。
const pendingAds = new WeakMap<TikTokMinisSDK, { blockingPlayback: boolean; attemptId: string }>();
// 同一容器的全屏广告共用失败退避，轮换广告位或广告类型都不能跳过等待。
const retryWindows = new WeakMap<TikTokMinisSDK, number>();
const unavailableForeground = new WeakMap<TikTokMinisSDK, number>();
const rejectedShowForeground = new WeakMap<TikTokMinisSDK, number>();
const outdatedRewardedClients = new WeakSet<TikTokMinisSDK>();
type AdAttempt = { id: string; scope?: object; release?: AdReleaseReason; closedAt?: number; closeCursor?: number };
// 每个 SDK 只保存最后一次实际 show 的关联键与关闭边界，不保存原始回调。
const lastShowAttempts = new WeakMap<TikTokMinisSDK, AdAttempt>();
const nativeEndTimes = new WeakMap<TikTokMinisSDK, number>();
const timelineKinds = new Set<AdMetricKind>(["ad_request", "ad_shown", "ad_closed", "ad_failure", "ad_show_unknown", "ad_close_unknown"]);

/** hasPendingFullscreenAd 包括页面等待已超时但原生结果尚未返回的广告。 */
export function hasPendingFullscreenAd(sdk: TikTokMinisSDK | undefined): boolean {
  return !!sdk && pendingAds.has(sdk);
}

/** isFullscreenAdBlockingPlayback 只在有界的展示/关闭等待期阻止视频恢复；超时隔离仍由 hasPendingFullscreenAd 保持。 */
export function isFullscreenAdBlockingPlayback(sdk: TikTokMinisSDK | undefined): boolean {
  return !!sdk && pendingAds.get(sdk)?.blockingPlayback === true;
}

/** lastFullscreenAdEndedAt 返回持有者确认关闭的单调时钟；失败拒绝、本地超时不会更新它。 */
export function lastFullscreenAdEndedAt(sdk: TikTokMinisSDK | undefined): number {
  return sdk ? nativeEndTimes.get(sdk) ?? -Infinity : -Infinity;
}

/** showFullscreenAd 使用当前已初始化的 sdk 和字符串广告位 adUnitId 创建单次实例。
 * 遵循短剧 H5 的 create → 注册回调 → show 流程，广告统计只记录本次实际调用和原生结果。
 * kind 区分激励和插屏；onShown 只确认一次展示，onLateCompleted 同步保存本地超时后的完播事实。
 * 返回 unknown 释放页面等待；已展示或 show 结果未定的错误继续隔离，直到关闭或容器销毁。
 * 回调必须绑定发起时的领取主体，不能用网页刷新或前后台切换推断原生请求已终止。
 * recoverContainer 仅供有限静默恢复在收到 retryable 后使用；不绕过意图校验、原生互斥或失败退避。
 */
export async function showFullscreenAd(
  sdk: TikTokMinisSDK | undefined,
  adUnitId: string,
  kind: "rewarded" | "interstitial",
  onShown?: () => void,
  onLateCompleted?: () => void,
  observe?: AdObserver,
  intent?: AdIntent,
  recoverContainer = false,
): Promise<FullscreenAdResult> {
  ensureVisibilityTracking(sdk);
  refreshVisibilitySnapshot();
  const request = intent ?? captureAdIntent();
  const prefix = kind === "rewarded" ? "rewarded_ad" : "interstitial_ad";
  const capability = kind === "rewarded" ? "createRewardedVideoAd" : "createInterstitialAd";
  const startedAt = performance.now();
  const metricStarted = performance.now();
  const attemptId = observe?.attemptId ?? createMetricID();
  const currentAttempt: AdAttempt = { id: attemptId, scope: observe?.timelineScope };
  const getPreviousAttempt = () => {
    const previous = sdk && lastShowAttempts.get(sdk);
    return previous?.scope === currentAttempt.scope ? previous : undefined;
  };
  let previousAttempt = getPreviousAttempt();
  let showEvidence: Pick<AdFailureFacts, "showDocument" | "showNative" | "showPrerender"> = {};
  let shown = false;
  let visible = getVisibilitySnapshot().visible;
  const failureFacts = (reason: unknown): AdFailureFacts => {
    const state = getVisibilitySnapshot();
    // 只记录一个错误的固定事实；在释放本次锁之前取值，避免把释放后的空锁误作原因。
    const text = (value: string) => {
      let result = value.slice(0, 192);
      while (new TextEncoder().encode(result).length > 192) result = result.slice(0, -1);
      return result;
    };
    const inner = platformInnerErrorMessage(reason);
    return { error: text(platformErrorMessage(reason, "Ad operation failed")), ...(inner ? { innerError: text(inner) } : {}),
      ...showEvidence, errorDocument: state.documentVisibility, errorNative: state.nativeVisibility, errorPrerender: state.prerendering,
      shown, userInitiated: request.userInitiated, lockOwnerId: sdk ? pendingAds.get(sdk)?.attemptId : undefined,
      ...(previousAttempt ? { previousAttemptId: previousAttempt.id, previousRelease: previousAttempt.release ?? "pending",
        ...(previousAttempt.closedAt === undefined ? {} : { previousCloseMs: Math.min(86400000, Math.max(0, Math.round(performance.now() - previousAttempt.closedAt))) }) } : {}),
    };
  };
  let showStarted: number | undefined;
  const metric = (kind: AdMetricKind, stage: AdObservation["stage"], extra: Partial<AdObservation> = {}) => {
    try {
      if (!observe) return;
      const { timeline: point, ...details } = extra;
      const now = performance.now();
      const hasTimeline = timelineKinds.has(kind) || kind === "ad_cancelled" && extra.reason === "user_cancel";
      const timeline = showStarted !== undefined && hasTimeline ? point ?? captureAdTimelinePoint(now) : undefined;
      observe({ kind, stage, elapsedMs: Math.min(86400000, Math.max(0, now - metricStarted)),
        ...(showStarted === undefined ? {} : { showElapsedMs: Math.min(86400000, Math.max(0, now - showStarted)) }),
        ...(timeline ? { timeline } : {}), ...details });
    }
    catch (reason) { logClientEvent("warn", "ad_metric_record_failed", { error: platformErrorMessage(reason, "Ad metric recording failed") }); }
  };
  metric("ad_trigger", "gate");
  // 明确的版本拒绝在同一实例内保持有效，避免重新尝试同一个不支持的能力。
  if (sdk && kind === "rewarded" && outdatedRewardedClients.has(sdk)) {
    metric("ad_skipped", "capability", { reason: "unsupported" });
    return { status: "failed", reason: "client_outdated" };
  }
  const logFailure = (reason: unknown, stage: string, showConfirmed = false) => {
    const codes = platformErrorCodes(reason);
    const cancelled = kind === "rewarded" && (stage === "show" || (stage === "callback" && showConfirmed)) && codes.errorCode === "30001";
    // onError 本身不提供明确的 API 来源；保留 callback 阶段，不能把同码的创建频控误认成用户取消。
    logClientEvent(cancelled ? "info" : codes.errorCode === "30001" ? "warn" : "error", `${prefix}_${cancelled ? "cancelled" : `${stage}_failed`}`, {
      stage, ...codes, elapsedMs: performance.now() - startedAt, adAttemptId: attemptId,
      error: platformErrorMessage(reason, "Ad operation failed"), innerError: platformInnerErrorMessage(reason),
    });
    return cancelled;
  };
  try {
    if (!sdk || !adUnitId.trim() || !sdk.canIUse?.(capability) || (kind === "interstitial" && !sdk.createInterstitialAd)) {
      logClientEvent("warn", `${prefix}_unsupported`, { error: "Ad capability or ad unit is unavailable" });
      metric("ad_skipped", "capability", { reason: "unsupported" });
      return { status: "unsupported" };
    }
  } catch (reason) {
    metric("ad_failure", "capability", { reason: "exception", ...platformErrorCodes(reason), failure: failureFacts(reason) });
    logFailure(reason, "capability");
    return { status: "failed", message: platformErrorMessage(reason, "Ad capability check failed") };
  }
  if (pendingAds.has(sdk)) {
    logClientEvent("warn", `${prefix}_pending`, { error: "A native full-screen ad is still pending" });
    metric("ad_skipped", "gate", { reason: "busy" });
    return { status: "unknown" };
  }
  const checkIntent = (): "not_visible" | "stale_intent" | undefined => {
    if (!refreshVisibilitySnapshot().visible) return "not_visible";
    if (request.visibilityEpoch !== getVisibilitySnapshot().epoch || !request.isCurrent()) return "stale_intent";
  };
  const skip = (reason: NonNullable<Extract<FullscreenAdResult, { status: "failed" }>["reason"]>): FullscreenAdResult => {
    logClientEvent("info", `${prefix}_deferred`, { error: `Ad display deferred: ${reason}`, adAttemptId: attemptId });
    metric("ad_skipped", "gate", { reason });
    return { status: "failed", reason };
  };
  let invalid: ReturnType<typeof checkIntent>;
  try { invalid = checkIntent(); }
  catch (reason) { metric("ad_failure", "gate", { reason: "exception", failure: failureFacts(reason) }); logFailure(reason, "gate"); return { status: "failed" }; }
  if (invalid) return skip(invalid);
  if (rejectedShowForeground.get(sdk) === getVisibilitySnapshot().foregroundEpoch) return skip("not_visible");
  if (!request.userInitiated && !recoverContainer && unavailableForeground.get(sdk) === getVisibilitySnapshot().foregroundEpoch) return skip("container_suspended");
  if ((retryWindows.get(sdk) ?? 0) > performance.now()) return skip("cooldown");
  const deferRetry = () => retryWindows.set(sdk, performance.now() + adPolicy.retryDelayMs);
  const pending = { blockingPlayback: true, attemptId: attemptId };
  pendingAds.set(sdk, pending);
  const release = (detail: AdReleaseReason) => {
    // 迟到的旧实例只能释放自身；拒绝的新调用不能宣告其他原生广告已经结束。
    if (pendingAds.get(sdk) === pending) { pendingAds.delete(sdk); currentAttempt.release = detail; }
    pending.blockingPlayback = false;
  };
  let ad: RewardedVideoAd;
  try {
    metric("ad_create", "create");
    ad = kind === "rewarded" ? sdk.createRewardedVideoAd({ adUnitId }) : sdk.createInterstitialAd!({ adUnitId });
    metric("ad_created", "create");
  } catch (reason) {
    refreshVisibilitySnapshot();
    const failure = failureFacts(reason);
    release("create_failed");
    const codes = platformErrorCodes(reason);
    const containerUnavailable = isAdContainerUnavailable(codes);
    const conflict = isAdActiveConflict(codes);
    if (containerUnavailable) unavailableForeground.set(sdk, getVisibilitySnapshot().foregroundEpoch);
    metric("ad_failure", "create", { reason: containerUnavailable ? "container_unavailable" : conflict ? "ad_active_conflict" : "sdk_error", ...codes, failure });
    if (!containerUnavailable) deferRetry();
    logFailure(reason, "create");
    return { status: "failed", ...(containerUnavailable ? { reason: "container_unavailable" as const, retryable: true as const }
      : conflict ? { reason: "active_conflict" as const, retryable: true as const } : {}), message: platformErrorMessage(reason, "Ad creation failed") };
  }

  return new Promise<FullscreenAdResult>((resolve) => {
    let localSettled = false;
    let nativeEnded = false;
    let failed = false;
    let showForeground: number | undefined;
    let phase: "show" | "close" = "show";
    let remaining: number = kind === "rewarded" ? adPolicy.rewardedShowTimeoutMs : adPolicy.interstitialTimeoutMs;
    let timerStarted = 0;
    let timer: number | undefined;
    let stopVisibility: (() => void) | undefined;
    let destroyListener: string | undefined;
    const stopTimer = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const settleLocal = (result: FullscreenAdResult) => {
      if (localSettled) return;
      localSettled = true;
      resolve(result);
    };
    const cleanup = () => {
      nativeEnded = true;
      stopTimer();
      try { stopVisibility?.(); } catch (reason) {
        logClientEvent("error", `${prefix}_visibility_listener_remove_failed`, { error: platformErrorMessage(reason, "Ad visibility listener removal failed") });
      }
      stopVisibility = undefined;
      for (const [operation, detach] of [
        [`${prefix}_close_listener_remove_failed`, () => ad.offClose?.(onClose)],
        [`${prefix}_error_listener_remove_failed`, () => ad.offError?.(onError)],
        [`${prefix}_destroy_listener_remove_failed`, () => {
          if (destroyListener !== undefined) sdk.off?.("minis.destroy", destroyListener);
          destroyListener = undefined;
        }],
      ] as const) {
        try { detach(); } catch (reason) {
          logClientEvent("error", operation, { error: platformErrorMessage(reason, "Ad listener removal failed"), ...platformErrorCodes(reason) });
        }
      }
    };
    const resumeTimer = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (!visible || !pending.blockingPlayback || nativeEnded) return;
      timerStarted = performance.now();
      timer = window.setTimeout(() => {
        // 官方没有取消原生广告的 API；超时恢复页面但保留请求隔离，真正关闭容器才能无回调恢复。
        pending.blockingPlayback = false;
        logClientEvent("error", `${prefix}_timeout`, {
          stage: phase, outcome: "unknown", recovery: "reopen_mini", elapsedMs: performance.now() - startedAt,
          error: `Ad ${phase} callback timed out`,
        });
        metric(phase === "close" ? "ad_close_unknown" : "ad_show_unknown", phase, { reason: "callback_timeout" });
        settleLocal({ status: "unknown" });
      }, remaining);
    };
    const markShown = (evidence: "show_promise" | "completed_close") => {
      if (shown) return;
      shown = true;
      // 新尝试已获原生展示证明，手动恢复后的自动衔接无需继续沿用旧 50008 暂停。
      unavailableForeground.delete(sdk);
      metric("ad_shown", "show", { evidence });
      try { onShown?.(); } catch (reason) {
        logClientEvent("error", `${prefix}_report_failed`, { error: platformErrorMessage(reason, "Ad event reporting failed") });
      }
    };
    const fail = (reason: unknown, stage: "setup" | "show" | "callback") => {
      refreshVisibilitySnapshot();
      const codes = platformErrorCodes(reason);
      if (nativeEnded) return;
      const failure = failed ? undefined : failureFacts(reason);
      const timeline = !failed && showStarted !== undefined ? captureAdTimelinePoint() : undefined;
      const conflict = isAdActiveConflict(codes);
      // show 已成功后任何错误都不能替代 onClose；结果未定的 onError 也不能证明未展示。
      // 11006 是本次未展示调用的明确拒绝，不据此永久锁死页面。
      const containerUnavailable = isAdContainerUnavailable(codes);
      // 50010 在发生该调用的前台周期内停止展示；迟到回调不能暂停已经重新进入的前台。
      const rejectedForeground = !shown && isAdForegroundRejected(codes) ? showForeground : undefined;
      if (rejectedForeground !== undefined) rejectedShowForeground.set(sdk, rejectedForeground);
      const outdated = !shown && kind === "rewarded" && showForeground !== undefined && codes.errorCode === "121401";
      if (outdated) outdatedRewardedClients.add(sdk);
      // 普通错误之后仍可能返回明确的 50008；更新容器状态不受失败计数去重限制。
      if (containerUnavailable) unavailableForeground.set(sdk, getVisibilitySnapshot().foregroundEpoch);
      const definitelyRejected = !shown && (stage !== "callback" || conflict || containerUnavailable ||
        rejectedForeground !== undefined || outdated || showStarted === undefined);
      if (definitelyRejected) {
        release(containerUnavailable ? "container_unavailable" : conflict ? "active_conflict" : stage === "setup" ? "setup_failed" : "show_rejected");
        // 明确未展示即移除监听；不为诊断保留失败实例，迟到回调由 nativeEnded 丢弃。
        cleanup();
      }
      // 业务失败与冷却只处理一次，重复回调不追加诊断或延长退避。
      if (failed) return;
      failed = true;
      const cancelled = logFailure(reason, stage, shown);
      metric(cancelled ? "ad_cancelled" : "ad_failure", stage, { reason: cancelled ? "user_cancel" : conflict ? "ad_active_conflict" : containerUnavailable ? "container_unavailable" : "sdk_error", ...codes, timeline, ...(cancelled ? {} : { failure }) });
      if (!cancelled && !containerUnavailable && rejectedForeground === undefined && !outdated) deferRetry();
      const resultReason = outdated ? "client_outdated" : rejectedForeground !== undefined ? "not_visible" :
        containerUnavailable ? "container_unavailable" : conflict ? "active_conflict" : undefined;
      settleLocal(cancelled ? { status: "cancelled" } : { status: "failed",
        ...(resultReason ? { reason: resultReason } : {}),
        ...(definitelyRejected && rejectedForeground === undefined && !outdated && (containerUnavailable || conflict) ? { retryable: true as const } : {}),
        message: platformErrorMessage(reason, "Ad display failed") });
    };
    const onClose = (result: RewardedAdCloseResult) => {
      if (nativeEnded) return;
      currentAttempt.closedAt = performance.now();
      currentAttempt.closeCursor = getAdLifecycleCursor();
      const timeline = captureAdTimelinePoint(currentAttempt.closedAt);
      // 回调处理开始即去重，避免 onShown 内同步重入 onClose 造成二次完播处理。
      nativeEnded = true;
      const owned = pendingAds.get(sdk) === pending;
      const completed = kind === "rewarded" && result?.isEnded === true;
      // 完播可证明实际观看；一般关闭也可能由素材/播放故障触发，不能据此补造展示。
      if (completed) markShown("completed_close");
      if (owned) nativeEndTimes.set(sdk, performance.now());
      release("closed");
      cleanup();
      metric("ad_closed", "close", { timeline });
      if (completed) metric("ad_complete", "close");
      else if (kind === "rewarded") metric("ad_cancelled", "close", { reason: "not_completed" });
      if (localSettled && completed) {
        try { onLateCompleted?.(); } catch (reason) {
          logClientEvent("error", `${prefix}_late_completion_failed`, { error: platformErrorMessage(reason, "Late ad completion could not be preserved") });
        }
      }
      if (localSettled) logClientEvent("info", `${prefix}_late_result`, {
        outcome: kind === "interstitial" ? "closed" : completed ? "completed" : "cancelled", elapsedMs: performance.now() - startedAt,
      });
      settleLocal(completed ? { status: "completed" } : { status: "cancelled" });
    };
    const onError = (reason: unknown) => fail(reason, "callback");
    const onShowSuccess = () => {
      if (nativeEnded) return;
      markShown("show_promise");
      if (nativeEnded) return;
      // 迟到展示仍可能覆盖页面；重新进入有界关闭等待，不能因本地 Promise 已结束而永远锁住视频。
      pending.blockingPlayback = true;
      phase = "close";
      remaining = kind === "rewarded" ? adPolicy.rewardedCloseTimeoutMs : adPolicy.interstitialTimeoutMs;
      resumeTimer();
    };

    let operation: "setup" | "show" = "setup";
    try {
      stopVisibility = observeVisibility(sdk, (next) => {
        if (visible === next) return;
        visible = next;
        if (!next && timer !== undefined) {
          remaining = Math.max(0, remaining - (performance.now() - timerStarted));
          window.clearTimeout(timer);
          timer = undefined;
        }
        // 返回前台只恢复剩余等待时间，不把生命周期信号解释为广告关闭或取消。
        if (next) resumeTimer();
      });
      try {
        destroyListener = sdk.on?.("minis.destroy", () => {
          if (nativeEnded) return;
          logClientEvent("warn", `${prefix}_container_destroyed`, { error: "Mini container destroyed before ad result was confirmed" });
          metric(phase === "close" ? "ad_close_unknown" : "ad_show_unknown", "destroy", { reason: "container_destroyed" });
          release("destroyed");
          cleanup();
          settleLocal({ status: "unknown" });
        });
      } catch (reason) {
        logClientEvent("warn", `${prefix}_destroy_listener_failed`, { error: platformErrorMessage(reason, "Ad container lifecycle unavailable"), ...platformErrorCodes(reason) });
      }
      ad.onClose(onClose);
      if (nativeEnded) return;
      ad.onError(onError);
      if (nativeEnded) return;
      // 先绑定本次实例的关闭与错误监听，再直接展示，避免同步结果丢失或重复发起请求。
      const invalid = checkIntent();
      if (invalid) {
        release(invalid);
        cleanup();
        settleLocal(skip(invalid));
        return;
      }
      operation = "show";
      showStarted = performance.now();
      const state = getVisibilitySnapshot();
      showForeground = state.foregroundEpoch;
      showEvidence = { showDocument: state.documentVisibility, showNative: state.nativeVisibility, showPrerender: state.prerendering };
      previousAttempt = getPreviousAttempt();
      lastShowAttempts.set(sdk, currentAttempt);
      resumeTimer();
      metric("ad_request", "show", { timeline: {
        ...captureAdTimelinePoint(showStarted),
        request: {
          userInitiated: request.userInitiated,
          ...(previousAttempt ? { previousAttemptId: previousAttempt.id } : {}),
          ...(previousAttempt?.closedAt !== undefined && previousAttempt.closeCursor !== undefined
            ? { previousCloseAtMs: Math.round(previousAttempt.closedAt), ...readAdLifecycleSince(previousAttempt.closeCursor) } : {}),
        },
      } });
      void ad.show().then(onShowSuccess, reason => fail(reason, "show"));
    } catch (reason) {
      fail(reason, operation);
    }
  });
}
