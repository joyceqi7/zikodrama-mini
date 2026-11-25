import { ApiError } from "./httpMiniDramaApi";
import { text } from "../copy";

// 按稳定错误码使用客户端固定文案，不透传服务端、代理或 SDK 的原始消息。
const LOCALIZED_ERROR_KEYS: Record<string, string> = {
  unhealthy: "apiErrors.serviceUnavailable",
  invalid_request: "apiErrors.invalidRequest",
  not_found: "apiErrors.notFound",
  invalid_reward_claim: "apiErrors.invalidRewardClaim",
  playback_unavailable: "apiErrors.playbackUnavailable",
  identity_changed: "apiErrors.identityChanged",
  unauthorized: "apiErrors.sessionUnavailable",
  bootstrap_failed: "apiErrors.sessionUnavailable",
  application_unavailable: "apiErrors.applicationUnavailable",
  application_forbidden: "apiErrors.applicationUnavailable",
  service_unavailable: "apiErrors.serviceUnavailable",
  identity_unavailable: "apiErrors.serviceUnavailable",
  identity_unsupported: "apiErrors.identityUnsupported",
  internal_error: "apiErrors.serviceUnavailable",
  network_error: "apiErrors.networkUnavailable",
  request_timeout: "apiErrors.requestTimeout",
  request_cancelled: "apiErrors.responseUnconfirmed",
  invalid_response: "apiErrors.responseUnconfirmed",
  reward_context_invalid: "runtime.rewardedAdFailed",
  ad_foreground_required: "runtime.rewardedAdFailed",
  rewarded_ad_unavailable: "runtime.rewardedAdFailed",
  rewarded_ad_client_outdated: "runtime.rewardedAdUnavailable",
  rewarded_ad_pending: "runtime.rewardedAdPending",
  vip_offer_unavailable: "runtime.dailyVipUnavailable",
  reward_pending_confirmation: "runtime.rewardConfirmationPending",
  rate_limited: "apiErrors.rateLimited",
  // 请求频率限制与应用自然日奖励上限不同，不能提示用户都等到明天。
  too_many_requests: "apiErrors.requestRateLimited",
};

// userMessage 是页面显示异常的唯一入口；未知错误使用页面提供的友好兜底。
export function userMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError && reason.code && Object.hasOwn(LOCALIZED_ERROR_KEYS, reason.code)) {
    return text(LOCALIZED_ERROR_KEYS[reason.code]);
  }
  return fallback;
}
