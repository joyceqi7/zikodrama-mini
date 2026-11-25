import type { Episode } from "../domain/types";

/**
 * 与官方 preload.ts 的职责一致：计算当前集附近的准备窗口。
 * 此处只计算窗口；媒体预加载由官方适配器按容器能力处理，
 * 不生成或缓存长期播放地址。
 */
export function playbackWindow(
  episodes: Episode[],
  activeIndex: number,
  radius = 2,
): Episode[] {
  if (episodes.length === 0 || activeIndex < 0) return [];
  return episodes.slice(
    Math.max(0, activeIndex - radius),
    Math.min(episodes.length, activeIndex + radius + 1),
  );
}
