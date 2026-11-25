import { expect, it, vi } from "vitest";
import { ensureTikTokSDK } from "./sdkReady";
import { ensureVisibilityTracking, getAdLifecycleCursor, getVisibilitySnapshot, observeVisibility, readAdLifecycleSince } from "./lifecycle";
import type { TikTokMinisSDK } from "./types";

/** lifecycleSDK 提供可重入的宿主事件，不访问外部容器。 */
function lifecycleSDK() {
  const listeners = new Map<string, () => void>();
  const sdk = { on: vi.fn((name: string, callback: () => void) => { listeners.set(name, callback); return name; }), off: vi.fn() } as unknown as TikTokMinisSDK;
  return { sdk, emit: (name: string) => listeners.get(name)?.() };
}

it("初始化完成后立即安装监听，隐藏证据跨订阅和 SDK 替换保留", async () => {
  const first = lifecycleSDK(), next = lifecycleSDK();
  const previous = window.TTMinis;
  window.TTMinis = first.sdk;
  try {
    await ensureTikTokSDK();
    expect(first.sdk.on).toHaveBeenCalledTimes(3);
    first.emit("minis.hide");
    const listener = vi.fn();
    const off = observeVisibility(first.sdk, listener);
    off();
    ensureVisibilityTracking(first.sdk);
    expect(first.sdk.on).toHaveBeenCalledTimes(3);
    expect(first.sdk.off).not.toHaveBeenCalled();
    ensureVisibilityTracking(next.sdk);
    expect(getVisibilitySnapshot()).toMatchObject({ documentVisibility: "visible", nativeVisibility: "hidden", visible: false });
    expect(first.sdk.off).toHaveBeenCalledTimes(3);
    next.emit("minis.show");
    const epoch = getVisibilitySnapshot().foregroundEpoch;
    next.emit("minis.show");
    expect(getVisibilitySnapshot().foregroundEpoch).toBe(epoch);
    expect(listener).not.toHaveBeenCalled();
  } finally { window.TTMinis = previous; }
});

it("SDK 初始化未结束时不提前调用 on，初始未知允许前台尝试但浏览器预渲染明确阻止", async () => {
  const h = lifecycleSDK();
  let finish!: () => void;
  window.TTMinis = h.sdk;
  window.__TIKTOK_MINIS_INITIALIZE__ = () => new Promise(resolve => { finish = resolve; });
  try {
    const ready = ensureTikTokSDK();
    expect(h.sdk.on).not.toHaveBeenCalled();
    finish(); await ready;
    expect(getVisibilitySnapshot()).toMatchObject({ nativeVisibility: "unknown", visible: true });
    Object.defineProperty(document, "prerendering", { configurable: true, value: true });
    document.dispatchEvent(new Event("prerenderingchange"));
    expect(getVisibilitySnapshot()).toMatchObject({ prerendering: true, visible: false });
  } finally {
    delete window.TTMinis; delete window.__TIKTOK_MINIS_INITIALIZE__;
    Reflect.deleteProperty(document, "prerendering");
  }
});

it("同步订阅者重入前台转换时不会继续发送过期后台通知", () => {
  const h = lifecycleSDK();
  const observed = vi.fn();
  let resume = false;
  observeVisibility(h.sdk, next => { if (!next && resume) h.emit("minis.show"); });
  observeVisibility(h.sdk, observed);
  h.emit("minis.hide");
  expect(observed.mock.calls).toEqual([[false]]);
  h.emit("minis.show");
  observed.mockClear(); resume = true;
  h.emit("minis.hide");
  expect(observed.mock.calls).toEqual([[true]]);
  expect(getVisibilitySnapshot().visible).toBe(true);
});

it("关闭后的生命周期只保留最近八条，标明缺口并保持同毫秒信号顺序", () => {
  const h = lifecycleSDK();
  ensureVisibilityTracking(h.sdk);
  h.emit("minis.show");
  const before = getAdLifecycleCursor();
  for (let i = 0; i < 6; i += 1) {
    h.emit("minis.hide");
    h.emit("minis.show");
  }
  const timeline = readAdLifecycleSince(before);
  expect(timeline.lifecycleTruncated).toBe(true);
  expect(timeline.lifecycle.map(event => event.source)).toEqual(Array.from({ length: 4 }).flatMap(() => ["minis.hide", "minis.show"]));
  expect(readAdLifecycleSince(getAdLifecycleCursor())).toEqual({ lifecycle: [], lifecycleTruncated: false });
});
