import type { TikTokMinisSDK } from "./types";
import { logClientEvent } from "../../observability/clientLog";
import { platformErrorMessage } from "./errors";

/** installImmersiveNavigation 将官方物理像素安全区映射为 CSS，旧容器保留 env 回退。 */
export function installImmersiveNavigation(sdk: TikTokMinisSDK | undefined): () => void {
  const update = () => {
    try {
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const rect = sdk?.getMenuButtonBoundingClientRect?.();
      const bottom = sdk?.getDeviceInfo?.()?.bottomHeight;
      if (rect && Number.isFinite(rect.bottom) && rect.bottom > 0) {
        document.documentElement.style.setProperty("--minis-top", `${rect.bottom / ratio + 8}px`);
        // 播放页返回按钮使用胶囊本身的几何信息与其保持同一中心线。
        if (Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0) {
          document.documentElement.style.setProperty("--minis-menu-top", `${rect.top / ratio}px`);
          document.documentElement.style.setProperty("--minis-menu-height", `${rect.height / ratio}px`);
        }
      }
      if (bottom !== undefined && Number.isFinite(bottom) && bottom >= 0) {
        document.documentElement.style.setProperty("--minis-bottom", `${bottom / ratio}px`);
      }
    } catch (error) { logClientEvent("warn", "navigation_geometry_failed", { error: platformErrorMessage(error, "Navigation geometry unavailable") }); }
  };
  try {
    sdk?.setNavigationBarColor?.({ frontColor: "#ffffff", backgroundColor: "#0b0b0d" }, (result) => {
      if (result?.error) logClientEvent("warn", "navigation_color_failed", { error: platformErrorMessage(result, "Navigation color unavailable") });
    });
  } catch (error) { logClientEvent("warn", "navigation_color_failed", { error: platformErrorMessage(error, "Navigation color unavailable") }); }
  update();
  window.addEventListener("resize", update);
  return () => {
    window.removeEventListener("resize", update);
    document.documentElement.style.removeProperty("--minis-top");
    document.documentElement.style.removeProperty("--minis-menu-top");
    document.documentElement.style.removeProperty("--minis-menu-height");
    document.documentElement.style.removeProperty("--minis-bottom");
  };
}
