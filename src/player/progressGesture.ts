import type { PlaybackSnapshot } from "./playbackEngine";

/** 仅接管官方进度条区域的相对拖动，最终定位仍交给官方播放内核。 */
export function bindProgressGesture(
  root: HTMLElement,
  snapshot: () => PlaybackSnapshot,
  seek: (seconds: number) => void,
  onSeekingChange?: (seeking: boolean) => void,
): { /** 切集前取消旧集尚未提交的拖动。 */ cancel(): void; /** 卸载时移除全部监听。 */ destroy(): void } {
  let drag: { id: number; x: number; y: number; start: number; duration: number; width: number; target: number; active: boolean; bar: HTMLElement; stage: Element | null } | undefined;
  const tip = document.createElement("div");
  tip.className = "relative-seek-time";
  const current = document.createElement("strong");
  const total = document.createElement("span");
  tip.append(current, document.createTextNode(" / "), total);
  const format = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  const barAt = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>(".xgplayer-controls .xgplayer-progress") : null;
  const block = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const cancel = () => {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    previous.bar.classList.remove("relative-seeking");
    previous.bar.style.removeProperty("--seek-progress");
    previous.stage?.classList.remove("is-seeking");
    if (previous.active) onSeekingChange?.(false);
    tip.remove();
    if (previous.bar.hasPointerCapture?.(previous.id)) previous.bar.releasePointerCapture(previous.id);
  };
  const down = (event: PointerEvent) => {
    const bar = barAt(event.target);
    if (!bar || event.button !== 0) return;
    block(event);
    if (drag) return;
    const state = snapshot();
    const width = (bar.querySelector(".xgplayer-progress-outer") || bar).getBoundingClientRect().width;
    if (!Number.isFinite(state.duration) || state.duration <= 0 || width <= 0) return;
    // 记录在播位置和触点，触点不映射成绝对进度，避免按下时跳动。
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: state.currentTime, duration: state.duration, width, target: state.currentTime, active: false, bar, stage: root.closest(".player-stage") };
    bar.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    block(event);
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) >= 6 && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
      if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
      drag.active = true;
      onSeekingChange?.(true);
      drag.bar.classList.add("relative-seeking");
      drag.stage?.classList.add("is-seeking");
      drag.bar.append(tip);
    }
    // 拖动期间固定起始快照，内核继续上报时间也不会让滑块漂移。
    drag.target = Math.max(0, Math.min(drag.duration, drag.start + dx / drag.width * drag.duration));
    drag.bar.style.setProperty("--seek-progress", `${drag.target / drag.duration * 100}%`);
    current.textContent = format(drag.target);
    total.textContent = format(drag.duration);
  };
  const up = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    block(event);
    const target = drag.target;
    const commit = drag.active && event.type === "pointerup";
    cancel();
    // 松手只提交一次；取消、轻触和纵向移动都不改变播放位置。
    if (commit) seek(target);
  };
  const legacy = (event: Event) => { if (barAt(event.target)) block(event); };
  root.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  root.addEventListener("lostpointercapture", up, true);
  window.addEventListener("blur", cancel);
  // 阻止官方插件的 touch/mouse 兼容事件再按绝对触点 seek。
  const legacyEvents = ["touchstart", "touchmove", "touchend", "mousedown", "mousemove", "mouseup", "click"];
  legacyEvents.forEach(name => root.addEventListener(name, legacy, { capture: true, passive: false }));
  return { cancel, destroy() {
    cancel();
    root.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    root.removeEventListener("lostpointercapture", up, true);
    window.removeEventListener("blur", cancel);
    legacyEvents.forEach(name => root.removeEventListener(name, legacy, true));
  } };
}
