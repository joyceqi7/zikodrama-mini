import { logClientEvent, safeErrorMessage, type ClientLogFields } from "../observability/clientLog";
import { platformErrorMessage } from "../platform/tiktok/errors";
import type { TikTokVePlayerInstance } from "../platform/tiktok/types";

/** playbackErrorFields 只提取 SDK 消息和数值错误码，不展开凭据、响应或媒体地址。 */
export function playbackErrorFields(reason: unknown, fallback: string): ClientLogFields {
  const value = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
  const nested = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  const numericCode = (input: unknown): string | undefined => {
    if (typeof input !== "number" && typeof input !== "string") return;
    const code = String(input);
    return /^-?\d{1,10}$/.test(code) ? code : undefined;
  };
  return {
    error: platformErrorMessage(reason, platformErrorMessage({
      message: value.errorMessage ?? value.Message ?? nested.errorMessage ?? nested.Message,
    }, fallback)),
    errorCode: numericCode(value.errorCode ?? value.error_code ?? value.code ?? nested.errorCode ?? nested.error_code ?? nested.code),
    veErrorCode: numericCode(value.veErrorCode ?? nested.veErrorCode),
  };
}

/** playbackMediaFields 观察 SDK 已有元素的加载事实，不读取 src、currentSrc 或完整内核对象。 */
export function playbackMediaFields(instance?: TikTokVePlayerInstance): ClientLogFields {
  try {
    const player = instance?.player;
    const media = player?.video ?? player?.media;
    const finite = (input: unknown): number | undefined => typeof input === "number" && Number.isFinite(input) ? input : undefined;
    return {
      mediaPresent: !!media,
      mediaConnected: media?.isConnected,
      readyState: finite(media?.readyState ?? player?.readyState),
      networkState: finite(media?.networkState),
      mediaErrorCode: finite(media?.error?.code),
      positionSeconds: finite(player?.currentTime ?? media?.currentTime),
      durationSeconds: finite(player?.duration ?? media?.duration),
      paused: player?.paused ?? media?.paused,
      muted: player?.muted ?? media?.muted,
      visibility: document.visibilityState,
    };
  } catch (reason) {
    // 宿主可能替换或收回媒体元素；诊断失败不能截断原有 SDK 事件和业务回调。
    logClientEvent("warn", "player_media_diagnostic_failed", { error: safeErrorMessage(reason) });
    return {};
  }
}

/** playbackResourceFields 仅采样浏览器已公开且匹配当前视频的请求，不输出媒体地址。 */
export function playbackResourceFields(instance: TikTokVePlayerInstance | undefined, sourceStartedAt: number): ClientLogFields {
  try {
    const media = instance?.player?.video ?? instance?.player?.media;
    // 仅用地址在本地匹配当前视频；blob/MSE、宿主隐藏的请求及未完成的请求没有可靠归属。
    const currentSource = media?.currentSrc;
    if (!currentSource || !/^https?:\/\//.test(currentSource) || typeof performance.getEntriesByName !== "function") return {};
    const recorded = (performance.getEntriesByName(currentSource, "resource") as PerformanceResourceTiming[])
      .find(entry => entry.startTime >= sourceStartedAt && entry.responseEnd > 0 && Number.isFinite(entry.duration));
    if (!recorded) return {};
    const span = (end: number, start: number) => start > 0 && Number.isFinite(end) && end >= start ? end - start : undefined;
    // 跨域没有公开细分时间时保留总时长，不能把缺失误报为零延迟。
    return {
      mediaRequestDurationMs: recorded.duration,
      mediaConnectMs: span(recorded.connectEnd, recorded.connectStart),
      mediaResponseWaitMs: span(recorded.responseStart, recorded.requestStart),
      mediaResponseTransferMs: span(recorded.responseEnd, recorded.responseStart),
    };
  } catch (reason) {
    logClientEvent("warn", "player_resource_timing_unavailable", { error: safeErrorMessage(reason) });
    return {};
  }
}
