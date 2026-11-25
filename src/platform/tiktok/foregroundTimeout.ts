import { getVisibilitySnapshot, observeVisibility } from "./lifecycle";
import type { TikTokMinisSDK } from "./types";

/** foregroundTimeout 只累计可见期间的等待；后台冻结不能被误判为网络或登录超时。
 * 返回清理函数；结束、取消后不再响应前后台事件，也不会自行重发请求。
 */
export function foregroundTimeout(callback: () => void, durationMs: number, sdk?: TikTokMinisSDK): () => void {
  let remaining = durationMs;
  let visible = getVisibilitySnapshot().visible;
  let startedAt = 0;
  let timer: number | undefined;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    unsubscribe?.();
  };
  const start = () => {
    if (stopped || !visible) return;
    startedAt = performance.now();
    timer = window.setTimeout(() => { stop(); callback(); }, Math.max(0, remaining));
  };
  unsubscribe = observeVisibility(sdk, next => {
    if (visible) remaining -= Math.max(0, performance.now() - startedAt);
    window.clearTimeout(timer);
    visible = next;
    start();
  });
  start();
  return stop;
}
