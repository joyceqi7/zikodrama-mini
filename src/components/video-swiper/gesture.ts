export type SwipePoint = { x: number; y: number };

export function episodeSwipeOffset(
  start: SwipePoint,
  end: SwipePoint,
): -1 | 0 | 1 {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.abs(deltaY) < 64 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.2) {
    return 0;
  }
  return deltaY < 0 ? 1 : -1;
}

// VEPLAYER_INTERACTIVE_SELECTOR 覆盖官方文档公开的控制栏、中央播放与重播/错误层。
// 不匹配整个 .xgplayer 根节点，确保观众仍可从视频画面上下滑动切集。
const VEPLAYER_INTERACTIVE_SELECTOR = [
  ".xgplayer-controls",
  ".xgplayer-start",
  ".xgplayer-replay",
  ".xgplayer-error",
].join(", ");

/** PLAYER_INTERACTIVE_SELECTOR 让 Swiper 与页面点击共用控件排除范围，展开简介可独立滚动。 */
export const PLAYER_INTERACTIVE_SELECTOR = [
  "button", "a", "input", "select", "textarea", "[role='button']", "[role='slider']",
  "[data-player-interactive='true']", ".theater-description.is-expanded", VEPLAYER_INTERACTIVE_SELECTOR,
].join(", ");

// isPlayerInteractiveTarget 识别业务控件与 VePlayer 官方交互区，避免控件操作触发页面播放切换。
export function isPlayerInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(PLAYER_INTERACTIVE_SELECTOR));
}
