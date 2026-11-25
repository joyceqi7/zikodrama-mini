import { afterEach, describe, expect, it } from "vitest";

import { installLeftEdgeGestureGuard } from "./leftEdgeGestureGuard";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.innerHTML = ""; });

function touchEvent(type: string, x: number, y: number, identifier = 1): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touch = { identifier, clientX: x, clientY: y } as Touch;
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [touch] });
  Object.defineProperty(event, "changedTouches", { value: [touch] });
  return event;
}

describe("Mini 左边缘手势守卫", () => {
  it("只拦截从左边缘开始的明显右滑", () => {
    cleanup = installLeftEdgeGestureGuard();
    const surface = document.body.appendChild(document.createElement("div"));

    surface.dispatchEvent(touchEvent("touchstart", 12, 100));
    const edgeSwipe = touchEvent("touchmove", 34, 102);
    surface.dispatchEvent(edgeSwipe);
    expect(edgeSwipe.defaultPrevented).toBe(true);

    surface.dispatchEvent(touchEvent("touchend", 34, 102));
    surface.dispatchEvent(touchEvent("touchstart", 80, 100));
    const middleSwipe = touchEvent("touchmove", 120, 101);
    surface.dispatchEvent(middleSwipe);
    expect(middleSwipe.defaultPrevented).toBe(false);
  });

  it("保留协议页等页面的纵向滚动", () => {
    cleanup = installLeftEdgeGestureGuard();
    const surface = document.body.appendChild(document.createElement("div"));
    surface.dispatchEvent(touchEvent("touchstart", 10, 80));
    const verticalMove = touchEvent("touchmove", 12, 120);
    surface.dispatchEvent(verticalMove);
    expect(verticalMove.defaultPrevented).toBe(false);
  });
});
