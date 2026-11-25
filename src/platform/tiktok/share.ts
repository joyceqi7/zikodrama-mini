import { logClientEvent } from "../../observability/clientLog";
import { platformErrorMessage } from "./errors";
import type {
  TikTokMinisSDK,
  TikTokShareOptions,
  TikTokShareResult,
} from "./types";

/** ShareOutcome 的 success 仅代表平台接受分享资料，不能证明用户已发布。 */
export type ShareOutcome =
  | { status: "success" }
  | { status: "unsupported" }
  | { status: "failed"; message?: string };

/** SharePayload 是当前剧集交给原生分享菜单的公开资料。 */
export type SharePayload = TikTokShareOptions;

function outcome(result: TikTokShareResult): ShareOutcome {
  if (result.is_success === true) return { status: "success" };
  logClientEvent("error", "share_failed", { error: platformErrorMessage(result, "Share configuration failed") });
  return { status: "failed" };
}

/** shareWithTikTok 仅在 minis.share 原生菜单事件内提供资料；它本身不会主动打开分享面板。 */
export function shareWithTikTok(
  sdk: TikTokMinisSDK | undefined,
  payload: SharePayload,
): Promise<ShareOutcome> {
  if (!sdk?.share) return Promise.resolve({ status: "unsupported" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ShareOutcome) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    const timer = window.setTimeout(() => {
      logClientEvent("error", "share_timeout", { error: "Share callback timed out" });
      finish({ status: "failed" });
    }, 5000);
    try {
      sdk.share?.((result) => { if (!settled) finish(outcome(result)); }, payload);
    } catch (error) {
      logClientEvent("error", "share_failed", { error: platformErrorMessage(error, "Share configuration failed") });
      finish({ status: "failed" });
    }
  });
}

/** registerTikTokShare 按 callbackId 解绑，并屏蔽切集后迟到的旧监听。 */
export function registerTikTokShare(
  sdk: TikTokMinisSDK | undefined,
  payload: SharePayload,
  onOutcome: (result: ShareOutcome) => void,
): () => void {
  if (!sdk?.on || !sdk.share) return () => undefined;
  let active = true;
  let callbackId: string | undefined;
  const listener = () => {
    if (active) void shareWithTikTok(sdk, payload).then((result) => { if (active) onOutcome(result); });
  };
  try { callbackId = sdk.on("minis.share", listener); }
  catch (error) { logClientEvent("error", "share_listener_failed", { error: platformErrorMessage(error, "Share listener failed") }); }
  return () => {
    active = false;
    try { if (callbackId) sdk.off?.("minis.share", callbackId); }
    catch (error) { logClientEvent("error", "share_cleanup_failed", { error: platformErrorMessage(error, "Share cleanup failed") }); }
  };
}
