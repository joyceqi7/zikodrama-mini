import { ApiError } from "../../api/httpMiniDramaApi";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import { foregroundTimeout } from "./foregroundTimeout";
import { ensureVisibilityTracking } from "./lifecycle";

let pending: Promise<void> | undefined;

/** ensureTikTokSDK 等待官方脚本并完成初始化；共享就绪任务，失败重试也遵守禁止 async/defer 的接入约束。 */
export function ensureTikTokSDK(): Promise<void> {
  if (pending) return pending;
  // 已安装的容器 SDK 和测试注入使用同一入口；生产初始化器仍必须执行。
  if (window.TTMinis && (!window.__TIKTOK_MINIS_INITIALIZE__ || window.__TIKTOK_MINIS_INITIALIZED__)) { ensureVisibilityTracking(window.TTMinis); return Promise.resolve(); }
  const startedAt = performance.now();
  const task = new Promise<void>((resolve, reject) => {
    let script: HTMLScriptElement | undefined;
    let settled = false;
    const finish = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      stopTimeout();
      if (script) { script.onload = null; script.onerror = null; }
      if (reason) { script?.remove(); reject(reason); } else resolve();
    };
    const stopTimeout = foregroundTimeout(() => finish(new ApiError("TikTok SDK initialization timed out", 0, "request_timeout")), 15_000);
    const initialize = async () => {
      try {
        if (!window.TTMinis) throw new Error("TikTok SDK script did not provide TTMinis");
        await window.__TIKTOK_MINIS_INITIALIZE__?.();
        ensureVisibilityTracking(window.TTMinis);
        // 仅采样本次初始化仍有效的完成时间；迟到完成不能伪装已超时任务恢复成功。
        if (!settled) logClientEvent("info", "tiktok_sdk_ready", { elapsedMs: Math.max(0, performance.now() - startedAt) });
        finish();
      } catch (reason) { finish(reason); }
    };
    if (window.TTMinis) { void initialize(); return; }
    // 复用 HTML 中按官方顺序接入的脚本；失败重试才重新创建，避免重复下载。
    const existing = document.querySelector<HTMLScriptElement>("script[data-tiktok-sdk]");
    script = existing ?? document.createElement("script");
    if (script.dataset.failed === "true") { finish(new Error("TikTok SDK script failed to load")); return; }
    if (script.dataset.loaded === "true") { void initialize(); return; }
    script.src = "https://connect.tiktok-minis.com/drama/sdk.js";
    // 动态创建的脚本默认 async=true，必须显式关闭，不能只修正 HTML 首次接入。
    script.async = false;
    script.defer = false;
    script.dataset.tiktokSdk = "true";
    script.onload = () => { void initialize(); };
    script.onerror = () => finish(new Error("TikTok SDK script failed to load"));
    if (!existing) document.head.append(script);
  });
  pending = task.catch(reason => {
    pending = undefined;
    logClientEvent("error", "tiktok_sdk_initialize_failed", { error: safeErrorMessage(reason) });
    throw reason;
  }).then(() => { pending = undefined; });
  return pending;
}
