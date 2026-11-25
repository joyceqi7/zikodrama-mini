import type { DramaSummary, HomeSections } from "../domain/types";
import { coverLoader } from "./coverLoader";

/** preloadDramaCovers 仅预取目录首行；后续卡片接近可视区时再排队。 */
export function preloadDramaCovers(dramas: DramaSummary[]): void {
  dramas.slice(0, 2).forEach(drama => {
    if (drama.coverUrl.trim()) coverLoader.request(drama.coverUrl, "low", true);
    if (drama.firstEpisodePosterUrl?.trim()) coverLoader.request(drama.firstEpisodePosterUrl, "low", true);
  });
}
/** preloadHomeCovers 优先下载轮播相邻封面与首屏热播，分类榜由可视区触发。 */
export function preloadHomeCovers(sections: HomeSections): void {
  sections.carousel.slice(0, 3).forEach((drama, index) => {
    if (drama.coverUrl.trim()) coverLoader.request(drama.coverUrl, index === 0 ? "high" : "auto", true);
    // 首屏首集画面低优先级预热，与播放页使用同尺寸缓存，不抢封面连接。
    if (drama.firstEpisodePosterUrl?.trim()) coverLoader.request(drama.firstEpisodePosterUrl, "low", true);
  });
  sections.hot.slice(0, 3).forEach(drama => {
    if (drama.coverUrl.trim()) coverLoader.request(drama.coverUrl, "auto", true);
  });
}
