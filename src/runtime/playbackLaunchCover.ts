import type { DramaSummary } from "../domain/types";
import type { Runtime } from "./runtime";

/** cachedPlaybackCover 优先交接当前主体已确认的目标集海报，无缓存才沿用公开首页封面，不借此推断分集授权或媒体来源。 */
export function cachedPlaybackCover(runtime: Runtime, dramaId: string, episodeId?: string): string {
  if (!dramaId) return "";
  const confirmed = episodeId ? runtime.getCachedPlaybackCover?.(dramaId, episodeId) : "";
  if (confirmed) return confirmed;
  const catalog = runtime.getCachedPublicCatalog?.()?.dramas ?? [];
  const sections = runtime.getCachedHomeSections?.();
  const candidates: DramaSummary[] = [
    ...catalog,
    ...(sections?.carousel ?? []),
    ...(sections?.hot ?? []),
    ...(sections?.rankings ?? []).flatMap((section) => section.dramas),
  ];
  // 未明确目标集或续播其他集时不能展示首集画面。
  const poster = candidates.find(drama => drama.id === dramaId && episodeId === drama.firstEpisodeId && drama.firstEpisodePosterUrl?.trim())?.firstEpisodePosterUrl;
  if (poster) return poster;
  return candidates.find((drama) => drama.id === dramaId && drama.coverUrl.trim())?.coverUrl || "";
}
