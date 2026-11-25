import type { LocalHistoryRecord } from "./localLibrary";
import type { DramaSummary } from "./types";

/** latestDramaHistory 返回一部剧唯一/最近的本地续播记录。 */
export function latestDramaHistory(history: readonly LocalHistoryRecord[], dramaId: string): LocalHistoryRecord | undefined {
  return history.filter(item => item.dramaId === dramaId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

/** resumeEpisodeId 选择当前剧最近观看的分集；历史为空时使用目录首集，不以最大集号代替最近观看。 */
export function resumeEpisodeId(history: readonly LocalHistoryRecord[], dramaId: string, firstEpisodeId: string): string {
  return latestDramaHistory(history, dramaId)?.episodeId || firstEpisodeId;
}

/** playbackEntryPath 在首页确定最终分集；无历史时才把首集首帧图交给播放页。 */
export function playbackEntryPath(history: readonly LocalHistoryRecord[], drama: DramaSummary): string {
  const saved = latestDramaHistory(history, drama.id);
  const episodeId = saved?.episodeId || drama.firstEpisodeId;
  const path = `/watch/${encodeURIComponent(drama.id)}/${encodeURIComponent(episodeId)}`;
  const poster = drama.firstEpisodePosterUrl?.trim();
  return !saved && poster ? `${path}?firstEpisodePosterUrl=${encodeURIComponent(poster)}` : path;
}
