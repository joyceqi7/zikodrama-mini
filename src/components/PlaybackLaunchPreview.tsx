import { useEffect, useLayoutEffect, useState } from "react";

import { coverThumbnail } from "./coverThumbnail";
import { text } from "../copy";
import { logClientEvent } from "../observability/clientLog";
import { campaignEpisodeLabel } from "../runtime/campaignEntryCover";
import type { CampaignCoverHint } from "../runtime/launchRoute";
import { cachedPlaybackCover } from "../runtime/playbackLaunchCover";
import type { Runtime } from "../runtime/runtime";

/** PlaybackLaunchPreviewProps 在身份、路由和入剧广告等待期间使用同一封面兜底。 */
export interface PlaybackLaunchPreviewProps {
  /** runtime 提供当前剧目的公开封面与身份隔离后的本地历史。 */
  runtime: Runtime;
  /** dramaId 指定已进入剧场的剧目；缺省时从启动路由读取。 */
  dramaId?: string;
  /** episodeId 指定目标分集，避免续播时误用首集海报。 */
  episodeId?: string;
  /** error 只在真实失败后显示，不遮挡广告拉起前的封面。 */
  error?: string;
  /** errorDetail 可补充已由服务端确认的进度，不作为播放授权。 */
  errorDetail?: string;
  /** onRetry 重试失败操作；缺省时不显示按钮。 */
  onRetry?(): void;
  /** onBack 允许广告故障时离开剧场；正常等待时不显示入口。 */
  onBack?(): void;
  /** identityReady 为 true 时才读取按 Visitor 隔离的历史海报。 */
  identityReady?: boolean;
  /** coverUrl 是起播决策返回的目标集海报或缩略图。 */
  coverUrl?: string;
  /** campaignCover 保留短链提供的公开封面与剧集摘要，等待起播授权。 */
  campaignCover?: CampaignCoverHint;
  /** deferCoverLookup 由起播决策提供海报时关闭独立目录读取。 */
  deferCoverLookup?: boolean;
}

/** playbackLaunchDramaId 从业务路由或启动参数识别内部剧目 ID；官方 AlbumID 不冒充业务 ID。 */
function playbackLaunchDramaId(runtime: Runtime): string {
  const routeId = /^#?\/watch\/([^/?#]+)\/[^/?#]+/.exec(window.location.hash)?.[1];
  if (routeId) {
    try { return decodeURIComponent(routeId); }
    catch { return ""; }
  }
  const query = new URLSearchParams(window.location.search);
  return query.get("dramaId")?.trim() || query.get("drama_id")?.trim() || runtime.getLaunchTarget()?.dramaId || "";
}

/** playbackLaunchEpisodeId 从当前启动路由取得目标分集，避免预览误用首集海报。 */
function playbackLaunchEpisodeId(runtime: Runtime): string {
  const routeEpisodeId = /^#?\/watch\/[^/?#]+\/([^/?#]+)/.exec(window.location.hash)?.[1];
  if (routeEpisodeId) {
    try { return decodeURIComponent(routeEpisodeId); }
    catch { return ""; }
  }
  return runtime.getLaunchTarget?.()?.episodeId || "";
}

/** PlaybackLaunchPreview 仅渲染目标封面或失败恢复入口；缓存未命中时只在身份就绪后查找目标海报。 */
export function PlaybackLaunchPreview({ runtime, dramaId: suppliedDramaId, episodeId: suppliedEpisodeId,
  error, errorDetail, onRetry, onBack, identityReady = false, coverUrl, campaignCover, deferCoverLookup = false }: PlaybackLaunchPreviewProps) {
  const dramaId = suppliedDramaId ?? playbackLaunchDramaId(runtime);
  const episodeId = suppliedEpisodeId ?? playbackLaunchEpisodeId(runtime);
  const readCover = () => {
    const historyPoster = identityReady && typeof runtime.localLibrary?.history === "function"
      ? runtime.localLibrary.history().find(item => item.dramaId === dramaId && item.episodeId === episodeId)?.posterUrl?.trim()
      : "";
    return historyPoster || coverUrl || campaignCover?.url || cachedPlaybackCover(runtime, dramaId, episodeId);
  };
  const [cover, setCover] = useState(readCover);

  useEffect(() => {
    // 登录前不读取个人接口；确认身份后只查询实际目标，和剧场共用在途详情，不再扫描目录找封面。
    if (deferCoverLookup || !identityReady || !dramaId || readCover() || !runtime.loadPlaybackCover) return;
    let active = true;
    void runtime.loadPlaybackCover(dramaId, episodeId).then(value => {
      if (active) setCover(value);
    }).catch(() => { /* runtime 已记录实际原因，封面失败不阻断入剧或改变播放验权。 */ });
    return () => { active = false; };
  }, [runtime, dramaId, episodeId, identityReady, coverUrl, campaignCover?.url, deferCoverLookup]);

  // 路由从占位首集切到历史分集时，在绘制前换图，避免先闪回剧目封面。
  useLayoutEffect(() => { setCover(readCover()); }, [runtime, dramaId, episodeId, identityReady, coverUrl, campaignCover?.url]);

  if (!cover && !error) return null;
  const episodeLabel = campaignCover ? campaignEpisodeLabel(campaignCover) : "";

  return <div className="playback-launch-preview" role={error ? "alert" : "status"} aria-busy={!error}>
    {cover && <img src={coverThumbnail(cover, 480)} alt="" aria-hidden="true" fetchPriority="high" onError={(event) => {
      logClientEvent("warn", "playback_launch_cover_image_failed", { error: event.currentTarget.getAttribute("src") !== cover
        ? "Playback preview thumbnail failed; retrying original image" : "Playback preview image failed to load" });
      if (event.currentTarget.getAttribute("src") !== cover) event.currentTarget.src = cover;
      else setCover("");
    }} />}
    {cover && !error && campaignCover && (campaignCover.title || episodeLabel) && <div className="campaign-cover-caption">
      {campaignCover.title && <div>{campaignCover.title}</div>}
      {episodeLabel && <div>{episodeLabel}</div>}
    </div>}
    {error && <div className="playback-launch-error">
      <p>{error}</p>
      {errorDetail && <small>{errorDetail}</small>}
      {onRetry && <button type="button" onClick={onRetry}>{text("common.retry")}</button>}
      {onBack && <button type="button" className="playback-launch-error-back" onClick={onBack}>{text("common.back")}</button>}
    </div>}
  </div>;
}
