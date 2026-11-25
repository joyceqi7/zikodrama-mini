import { logClientEvent, safeErrorMessage } from "./clientLog";

// 同一页面只保留一个在途加载；失败后可显式重试，不重复下载诊断脚本。
const pendingPages = new WeakSet<Window>();

function initializeConsole(): void {
  if (!window.VConsole) {
    logClientEvent("warn", "preview_console_unavailable", { error: "TikTok preview console script did not load" });
    return;
  }
  try {
    // 不开启网络、存储、元素检查插件，避免在面板中收集请求凭据和本地会话。
    new window.VConsole({ defaultPlugins: ["system"], log: { maxLogNumber: 300, showTimestamps: true } });
  } catch (reason) {
    logClientEvent("warn", "preview_console_unavailable", { error: safeErrorMessage(reason) });
  }
}

/** installPreviewConsole 只响应 Sandbox 标记，在页面 load 后异步加载日志面板，网络慢或失败都不延迟业务启动。 */
export function installPreviewConsole(): void {
  if (!window.__PLAYBACK_PREVIEW_CONSOLE__) return;
  if (window.VConsole) {
    initializeConsole();
    return;
  }
  if (pendingPages.has(window)) return;
  pendingPages.add(window);
  const loadConsole = () => {
    try {
      const script = document.createElement("script");
      script.dataset.playbackPreviewConsole = "true";
      script.async = true;
      script.src = "https://connect.tiktok-minis.com/libs/vConsole.js";
      const finish = (loaded: boolean) => {
        script.onload = null;
        script.onerror = null;
        pendingPages.delete(window);
        if (loaded) initializeConsole();
        else logClientEvent("warn", "preview_console_unavailable", { error: "TikTok preview console script did not load" });
      };
      script.onload = () => finish(true);
      script.onerror = () => finish(false);
      document.head.append(script);
    } catch (reason) {
      pendingPages.delete(window);
      logClientEvent("warn", "preview_console_unavailable", { error: safeErrorMessage(reason) });
    }
  };
  // HTML 中的 async 脚本仍会延迟 window.load；在 load 后再插入，确保调试 CDN 不拖住宿主加载页。
  if (document.readyState === "complete") loadConsole();
  else window.addEventListener("load", loadConsole, { once: true });
}
