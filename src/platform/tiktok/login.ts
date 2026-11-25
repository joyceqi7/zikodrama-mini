import type {
  TikTokLoginCallback,
  TikTokLoginOptions,
  TikTokLoginResult,
  TikTokMinisSDK,
} from "./types";
import { ApiError } from "../../api/httpMiniDramaApi";
import { platformErrorMessage } from "./errors";
import { logClientEvent } from "../../observability/clientLog";
import { foregroundTimeout } from "./foregroundTimeout";

type CompatibleLoginHandler = TikTokLoginCallback & TikTokLoginOptions;

function loginCode(result: TikTokLoginResult | undefined): string | undefined {
  const code = result?.code || result?.authResponse?.code;
  return typeof code === "string" ? code.trim() || undefined : undefined;
}

/** requestSilentLoginCode 只返回官方有效换码凭据；平台故障不能伪装成匿名或凭据失效。 */
export function requestSilentLoginCode(
  sdk: TikTokMinisSDK | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let dispatchedAt: number | undefined;
    let stopTimeout: (() => void) | undefined;
    const settle = (code?: string, failure?: ApiError, reason?: unknown) => {
      if (settled) return;
      settled = true;
      stopTimeout?.();
      if (failure) {
        logClientEvent(failure.code === "identity_unsupported" ? "warn" : "error", "tiktok_silent_login_failed", {
          error: platformErrorMessage(reason ?? failure, failure.message),
        });
        reject(failure);
      } else {
        if (dispatchedAt !== undefined) logClientEvent("info", "tiktok_silent_login_succeeded", { elapsedMs: performance.now() - dispatchedAt });
        resolve(code!);
      }
    };
    try {
      if (!sdk || typeof sdk.login !== "function" || (sdk.canIUse && !sdk.canIUse("login"))) {
        settle(undefined, new ApiError("Silent login is unsupported", 503, "identity_unsupported"));
        return;
      }
      // 冷启动与前台恢复的桥接可能晚于三秒；只给前台有限等待，不降级为匿名登录。
      stopTimeout = foregroundTimeout(() => settle(undefined, new ApiError("Silent login timed out", 0, "request_timeout")), 15_000, sdk);
      const handler = ((result: TikTokLoginResult) => {
        const code = loginCode(result);
        settle(code, code ? undefined : new ApiError("Silent login returned no code", 503, "identity_unavailable"));
      }) as CompatibleLoginHandler;
      handler.success = handler;
      handler.fail = (result) => settle(undefined, new ApiError("Silent login failed", 503, "identity_unavailable"), result);
      dispatchedAt = performance.now();
      logClientEvent("info", "tiktok_silent_login_started");
      sdk.login(handler);
    } catch (reason) {
      settle(undefined, new ApiError("Silent login bridge failed", 503, "identity_unavailable"), reason);
    }
  });
}
