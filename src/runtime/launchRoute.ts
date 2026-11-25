function isRootLaunch(hash: string): boolean {
  return !hash || hash === "#" || hash === "#/" || hash === "/";
}

/** campaignCoverOrigin 用于校验投放入口提前读取封面的公开 CDN。 */
export const campaignCoverOrigin = "https://img.tkdrama.site";
const coverParameters = [
  "coverDramaId", "coverEpisodeId", "coverKey", "coverTitle", "coverEpisodeNumber", "coverEpisodeCount",
  "platformDramaId", "platformEpisodeId",
] as const;
const coverID = /^[1-9][0-9]{0,19}$/;
const coverPath = /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,255}$/;

/** readCampaignCode 仅在投放首页识别活动，并兼容旧短链中的字段别名。 */
export function readCampaignCode(hash: string, search: string): string {
  if (!isRootLaunch(hash)) return "";
  const query = new URLSearchParams(search);
  const code = ["campaignCode", "campaign_code", "campaign"].map(key => query.get(key)?.trim()).find(Boolean) || "";
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code) ? code : "";
}

/** CampaignCoverHint 是首屏公开展示信息，服务端确认目标与权益后才进入播放。 */
export interface CampaignCoverHint {
  /** dramaId 是用于匹配起播结果的业务剧目 ID。 */
  dramaId: string;
  /** episodeId 是用于匹配起播结果的业务分集 ID。 */
  episodeId: string;
  /** url 是公开 CDN 封面地址。 */
  url: string;
  /** title 是发布时的剧名。 */
  title?: string;
  /** episodeNumber 是当前集序号。 */
  episodeNumber?: string;
  /** episodeCount 是发布时的总集数。 */
  episodeCount?: string;
}

/** readCampaignCover 读取当前投放的首屏提示，只允许加载自有 CDN 的公开图片。 */
export function readCampaignCover(hash: string, search: string): CampaignCoverHint | undefined {
  if (!isRootLaunch(hash)) return;
  const query = new URLSearchParams(search);
  const dramaId = query.get("coverDramaId") || "";
  const episodeId = query.get("coverEpisodeId") || "";
  const key = query.get("coverKey") || "";
  if (!query.get("campaignCode")?.trim() || !coverID.test(dramaId) || !coverID.test(episodeId) ||
      !coverPath.test(key) || key.split("/").some(segment => !segment || segment === "." || segment === "..")) return;
  const hint: CampaignCoverHint = { dramaId, episodeId, url: campaignCoverOrigin + "/" + key };
  const title = query.get("coverTitle")?.trim();
  if (title && Array.from(title).length <= 80) hint.title = title;
  const episodeNumber = query.get("coverEpisodeNumber") || "";
  const episodeCount = query.get("coverEpisodeCount") || "";
  const positiveCount = /^[1-9][0-9]{0,5}$/;
  if (positiveCount.test(episodeNumber) && positiveCount.test(episodeCount) && Number(episodeNumber) <= Number(episodeCount)) {
    hint.episodeNumber = episodeNumber;
    hint.episodeCount = episodeCount;
  }
  return hint;
}

/** hasPlaybackLaunch 识别剧集或投放入口，目标剧集和播放权限仍由服务端确认。 */
export function hasPlaybackLaunch(hash: string, search: string): boolean {
  if (/^#?\/watch\//.test(hash)) return true;
  if (!isRootLaunch(hash)) return false;
  const query = new URLSearchParams(search);
  return ["campaignCode", "campaign_code", "campaign", "dramaId", "drama_id", "albumId", "album_id", "episodeId", "episode_id"].some(key => Boolean(query.get(key)?.trim()));
}

/** applyCampaignPreview 在预览包的普通扫码入口补入投放码，使启动与验权消费同一实际 URL。 */
export function applyCampaignPreview(campaignCode: string, launchQuery?: string): void {
  const url = new URL(window.location.href);
  // 真实投放、显式剧集和非首页路由优先，预览不改写已有落地或点击归因。
  if (!campaignCode || !isRootLaunch(url.hash) || hasPlaybackLaunch(url.hash, url.search) || url.searchParams.get("ttclid")?.trim()) return;
  url.searchParams.set("campaignCode", campaignCode);
  if (launchQuery) {
    // 预览包仅复用短链的展示字段，其他参数不能进入身份与起播请求。
    const params = new URLSearchParams(launchQuery);
    for (const name of coverParameters) {
      const value = params.get(name);
      if (value) url.searchParams.set(name, value);
    }
    if (!readCampaignCover(url.hash, url.search)) coverParameters.forEach(name => url.searchParams.delete(name));
  }
  window.history.replaceState(window.history.state, "", url);
}
