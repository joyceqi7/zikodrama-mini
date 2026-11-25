import { useEffect, useRef } from "react";
import { getVisibilitySnapshot, observeVisibility } from "../platform/tiktok/lifecycle";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import type { Runtime } from "../runtime/runtime";

/** useForegroundRefresh 后台停留后复核公开内容，短暂前后台抖动不重复刷新。 */
export function useForegroundRefresh(runtime: Runtime, refresh: () => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    let disposed = false;
    let hiddenAt: number | undefined = getVisibilitySnapshot().visible ? undefined : Date.now();
    const listener = (visible: boolean) => {
      if (!visible) hiddenAt ??= Date.now();
      else if (hiddenAt !== undefined) {
        const elapsed = Date.now() - hiddenAt;
        hiddenAt = undefined;
        if (elapsed >= 5000) latest.current();
      }
    };
    let off = observeVisibility(window.TTMinis, listener);
    if (runtime.whenPlatformReady) void runtime.whenPlatformReady().then(() => {
      if (disposed) return;
      off(); off = observeVisibility(window.TTMinis, listener);
    }).catch(reason => logClientEvent("warn", "public_refresh_lifecycle_unavailable", { error: safeErrorMessage(reason) }));
    return () => { disposed = true; off(); };
  }, [runtime]);
}
