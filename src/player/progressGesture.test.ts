import { afterEach, describe, expect, it, vi } from "vitest";
import { bindProgressGesture } from "./progressGesture";

let binding: ReturnType<typeof bindProgressGesture>;
afterEach(() => { binding?.destroy(); document.body.innerHTML = ""; });
function setup(onSeekingChange?: (seeking: boolean) => void) {
  document.body.innerHTML = '<div class="player-stage"><div class="player-root"><div class="xgplayer-controls"><div class="xgplayer-progress"><div class="xgplayer-progress-outer"></div></div></div></div></div>';
  const root = document.querySelector<HTMLElement>(".player-root")!;
  const bar = document.querySelector<HTMLElement>(".xgplayer-progress")!;
  const outer = bar.firstElementChild!;
  vi.spyOn(outer, "getBoundingClientRect").mockReturnValue({ width: 300 } as DOMRect);
  const snapshot = { currentTime: 18, duration: 84, paused: false, ended: false };
  const seek = vi.fn();
  binding = bindProgressGesture(root, () => snapshot, seek, onSeekingChange);
  const pointer = (type: string, x: number, y = 0, id = 1) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: id });
    (type === "pointerdown" ? bar : window).dispatchEvent(event);
  };
  return { bar, snapshot, seek, pointer };
}
describe("播放进度相对手势", () => {
  it("仅有效横向拖动通知显隐状态，松手和取消都结束操作", () => {
    const changed = vi.fn();
    const { pointer } = setup(changed);
    pointer("pointerdown", 100);
    pointer("pointerup", 100);
    expect(changed).not.toHaveBeenCalled();
    pointer("pointerdown", 100);
    pointer("pointermove", 130);
    expect(changed).toHaveBeenLastCalledWith(true);
    pointer("pointerup", 130);
    expect(changed).toHaveBeenLastCalledWith(false);
    pointer("pointerdown", 100);
    pointer("pointermove", 130);
    binding.cancel();
    expect(changed.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
  });
  it("任意触点从在播位置开始，播放回调不改变拖动基准，松手只定位一次", () => {
    const { bar, snapshot, seek, pointer } = setup();
    pointer("pointerdown", 250);
    expect(seek).not.toHaveBeenCalled();
    expect(bar).not.toHaveClass("relative-seeking");
    snapshot.currentTime = 25;
    pointer("pointermove", 280);
    expect(bar.style.getPropertyValue("--seek-progress")).toBe(`${26.4 / 84 * 100}%`);
    expect(bar.textContent).toBe("00:26 / 01:24");
    expect(seek).not.toHaveBeenCalled();
    pointer("pointerup", 280);
    expect(seek).toHaveBeenCalledExactlyOnceWith(26.4);
    expect(bar).not.toHaveClass("relative-seeking");
  });
  it("轻触和纵向手势不跳转", () => {
    const { seek, pointer } = setup();
    pointer("pointerdown", 250); pointer("pointerup", 250);
    pointer("pointerdown", 250); pointer("pointermove", 252, 30); pointer("pointerup", 252, 30);
    expect(seek).not.toHaveBeenCalled();
  });
  it("左右拖动限制在零到总时长", () => {
    const { seek, pointer } = setup();
    pointer("pointerdown", 200); pointer("pointermove", -100); pointer("pointerup", -100);
    expect(seek).toHaveBeenLastCalledWith(0);
    pointer("pointerdown", 20); pointer("pointermove", 600); pointer("pointerup", 600);
    expect(seek).toHaveBeenLastCalledWith(84);
  });
  it("系统取消、切集和卸载都丢弃未提交的位置", () => {
    const { bar, seek, pointer } = setup();
    for (const end of [() => pointer("pointercancel", 90), () => binding.cancel(), () => binding.destroy()]) {
      pointer("pointerdown", 30); pointer("pointermove", 90); end(); pointer("pointerup", 90);
      expect(bar).not.toHaveClass("relative-seeking");
    }
    expect(seek).not.toHaveBeenCalled();
  });
  it("兼容触摸事件不会传播到官方插件触发绝对定位", () => {
    const { bar } = setup();
    const native = vi.fn(); bar.addEventListener("touchstart", native);
    bar.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
    expect(native).not.toHaveBeenCalled();
  });
});
