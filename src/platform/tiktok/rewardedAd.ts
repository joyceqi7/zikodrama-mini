import { captureAdIntent, type AdIntent } from "./adIntent";
import { adPolicy } from "../../config/adPolicy";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import type { AdObserver } from "../../observability/adMetrics";
import { showFullscreenAd, type FullscreenAdResult } from "./fullscreenAd";
import { ensureVisibilityTracking, observeVisibility, refreshVisibilitySnapshot } from "./lifecycle";
import type { TikTokMinisSDK } from "./types";

/** RewardedAdResult 只有 completed 可进入领奖；unknown 表示原生仍未确认结果，禁止自动重拉。 */
export type RewardedAdResult = FullscreenAdResult;

/** showRewardedAd 对明确未展示的宿主拒绝进行有界静默恢复；复用原意图和 ClaimID，未知结果保留原生互斥与迟到完播归属。 */
export async function showRewardedAd(
  sdk: TikTokMinisSDK | undefined,
  adUnitId: string,
  onShown?: () => void,
  onLateCompleted?: () => void,
  observe?: AdObserver,
  intent?: AdIntent,
): Promise<RewardedAdResult> {
  ensureVisibilityTracking(sdk);
  const request = intent ?? captureAdIntent();
  let observer = observe;
  let result = await showFullscreenAd(sdk, adUnitId, "rewarded", onShown, onLateCompleted, observer, request);
  for (let retry = 0; retry < adPolicy.rewardedSilentRetries && result.status === "failed" && result.retryable; retry += 1) {
    logClientEvent("info", "rewarded_ad_recovery_waiting", { outcome: result.reason, adAttemptId: observer?.attemptId });
    const invalid = await waitForRecovery(sdk, request);
    if (invalid) {
      logClientEvent("info", "rewarded_ad_recovery_cancelled", { outcome: invalid, adAttemptId: observer?.attemptId });
      return { status: "failed", reason: invalid };
    }
    // 每次原生调用使用独立诊断键；业务曝光、奖励与迟到回调仍归同一个观看请求。
    try { observer = observer?.nextAttempt?.() ?? observer; }
    catch (reason) {
      logClientEvent("warn", "rewarded_ad_recovery_observer_failed", { error: safeErrorMessage(reason) });
      observer = undefined;
    }
    result = await showFullscreenAd(sdk, adUnitId, "rewarded", onShown, onLateCompleted, observer, request, true);
  }
  if (result.status === "failed" && result.retryable) {
    logClientEvent("warn", "rewarded_ad_recovery_exhausted", { outcome: result.reason, adAttemptId: observer?.attemptId });
  }
  return result;
}

// 等待只检查本地意图，不查询业务接口；进入后台即结束，不能在新前台周期续用旧 Offer。
function waitForRecovery(sdk: TikTokMinisSDK | undefined, intent: AdIntent): Promise<"not_visible" | "stale_intent" | undefined> {
  return new Promise(resolve => {
    const deadline = performance.now() + adPolicy.rewardedRecoveryDelayMs;
    let timer: number | undefined;
    let stopVisibility: (() => void) | undefined;
    let settled = false;
    const finish = (reason?: "not_visible" | "stale_intent") => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      stopVisibility?.();
      resolve(reason);
    };
    const check = () => {
      if (settled) return;
      const state = refreshVisibilitySnapshot();
      if (settled) return;
      if (!state.visible) return finish("not_visible");
      try {
        if (state.epoch !== intent.visibilityEpoch || !intent.isCurrent()) return finish("stale_intent");
      } catch (reason) {
        logClientEvent("error", "rewarded_ad_recovery_intent_failed", { error: safeErrorMessage(reason) });
        return finish("stale_intent");
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return finish();
      window.clearTimeout(timer);
      timer = window.setTimeout(check, Math.min(remaining, adPolicy.nativeAdRecoveryCheckMs));
    };
    stopVisibility = observeVisibility(sdk, check);
    check();
  });
}
