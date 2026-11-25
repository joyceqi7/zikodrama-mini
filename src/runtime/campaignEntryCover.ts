import { coverThumbnail } from "../components/coverThumbnail";
import { logClientEvent } from "../observability/clientLog";
import type { CampaignCoverHint } from "./launchRoute";
import { text } from "../copy";

/** campaignEpisodeLabel 将有效的当前集和总集数格式化为首屏标签。 */
export function campaignEpisodeLabel(hint: CampaignCoverHint): string {
  return hint.episodeNumber && hint.episodeCount
    ? text("player.episodeProgress", { current: hint.episodeNumber, total: hint.episodeCount })
    : "";
}

/** showCampaignEntryCover 在启动身份之前显示已校验的公开剧封面，React 挂载后沿用同一图片。 */
export function showCampaignEntryCover(hint: CampaignCoverHint): void {
  const { url } = hint;
  const root = document.getElementById("root");
  if (!root) return;
  const shell = document.createElement("div");
  shell.className = "campaign-entry-cover";
  shell.hidden = true;
  const image = document.createElement("img");
  image.alt = "";
  image.fetchPriority = "high";
  image.setAttribute("data-campaign-entry-cover", "");
  image.onload = () => {
    if (!image.isConnected) return;
    shell.hidden = false;
    logClientEvent("info", "campaign_entry_cover_ready", { elapsedMs: performance.now() });
  };
  image.onerror = () => {
    if (!image.isConnected) return;
    if (image.src !== url) image.src = url;
    else {
      logClientEvent("warn", "campaign_entry_cover_failed", { error: "Campaign entry cover image failed to load" });
      shell.remove();
    }
  };
  shell.append(image);
  const episode = campaignEpisodeLabel(hint);
  if (hint.title || episode) {
    const caption = document.createElement("div");
    caption.className = "campaign-cover-caption";
    for (const value of [hint.title, episode]) {
      if (!value) continue;
      const line = document.createElement("div");
      line.textContent = value;
      caption.append(line);
    }
    shell.append(caption);
  }
  root.append(shell);
  image.src = coverThumbnail(url, 480);
}
