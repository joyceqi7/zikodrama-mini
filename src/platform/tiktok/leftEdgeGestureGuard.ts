const EDGE_START_PX = 24;
const DIRECTION_LOCK_PX = 8;

/** installLeftEdgeGestureGuard 在整个 Mini 页面内拦截左边缘右滑，避免宿主优先将其识别为退出手势。 */
export function installLeftEdgeGestureGuard(target: Document = document): () => void {
  let gesture: { identifier: number; x: number; y: number; active: boolean } | undefined;
  const touchById = (list: TouchList, identifier: number) => Array.from(list).find(touch => touch.identifier === identifier);
  const reset = () => { gesture = undefined; };
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) { reset(); return; }
    const touch = event.touches[0];
    gesture = touch.clientX <= EDGE_START_PX
      ? { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, active: false }
      : undefined;
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    const touch = touchById(event.touches, gesture.identifier);
    if (!touch) { reset(); return; }
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.active) {
      if (Math.abs(dy) >= DIRECTION_LOCK_PX && Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      if (dx <= -DIRECTION_LOCK_PX) { reset(); return; }
      if (dx < DIRECTION_LOCK_PX || dx <= Math.abs(dy)) return;
      gesture.active = true;
    }
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const end = (event: TouchEvent) => {
    if (gesture && touchById(event.changedTouches, gesture.identifier)) reset();
  };
  target.addEventListener("touchstart", start, { capture: true, passive: true });
  target.addEventListener("touchmove", move, { capture: true, passive: false });
  target.addEventListener("touchend", end, true);
  target.addEventListener("touchcancel", end, true);
  return () => {
    reset();
    target.removeEventListener("touchstart", start, true);
    target.removeEventListener("touchmove", move, true);
    target.removeEventListener("touchend", end, true);
    target.removeEventListener("touchcancel", end, true);
  };
}
