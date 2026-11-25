import type { HttpMiniDramaApi } from "../api/httpMiniDramaApi";
import { coverThumbnail } from "../components/coverThumbnail";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import { campaignCoverOrigin, readCampaignCode, type CampaignCoverHint } from "./launchRoute";

interface PreparedCover {
  /** search 绑定本次落地地址，路由或投放参数变化后不能继续展示旧封面。 */
  search: string;
  /** cover 是服务端验证为可见的公开剧集摘要。 */
  cover: CampaignCoverHint;
}

let preparedCover: PreparedCover | undefined;
const listeners = new Set<() => void>();

/** subscribeCampaignPreparation 让已挂载的首屏接收晚于 React 的公开摘要。 */
export function subscribeCampaignPreparation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** getCampaignPreparation 交接首屏摘要，只用于渲染，不能成为路由或播放授权。 */
export function getCampaignPreparation(): PreparedCover | undefined {
  return preparedCover;
}

/** prepareCampaignCover 在启动身份的同时准备目标旧短链的海报和集数；接口缺失或失败时由原落地链路继续。 */
export function prepareCampaignCover(api: HttpMiniDramaApi, tiktokAppId: string, search: string, isCurrent: () => boolean): void {
  const code = readCampaignCode(window.location.hash, search);
  if (!code) return;
  void api.prepareCampaignPlayback(tiktokAppId, code).then(result => {
    if (!result || !isCurrent()) return;
    const url = result.coverUrl ? new URL(result.coverUrl) : undefined;
    // 只提前请求自有公开 CDN 的封面，不使用外部地址、带签名的图片或媒体源。
    if (!url || url.origin !== campaignCoverOrigin || url.username || url.password || url.search || url.hash) return;
    const cover: CampaignCoverHint = { ...result.target, url: url.href, title: result.title };
    if (result.episodeNumber > 0 && result.episodeCount >= result.episodeNumber) {
      cover.episodeNumber = String(result.episodeNumber);
      cover.episodeCount = String(result.episodeCount);
    }
    const image = new Image();
    image.fetchPriority = "high";
    image.src = coverThumbnail(cover.url, 480);
    preparedCover = { search, cover };
    for (const listener of listeners) listener();
  }, () => {
    // API 已记录旧 Server 未部署入口或请求失败；原会话和起播任务继续。
  }).catch(reason => {
    logClientEvent("warn", "campaign_playback_cover_invalid", { error: safeErrorMessage(reason) });
  });
}
