import { afterEach, expect, it, vi } from "vitest";
import { registerTikTokShare, shareWithTikTok } from "./share";
import { FullscreenAdGate, showInterstitial } from "./interstitialAd";
import { observeVisibility } from "./lifecycle";
import { installImmersiveNavigation } from "./navigation";
import type { TikTokMinisSDK } from "./types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("分享按官方 callbackId 解绑，迟到回调不提交旧剧集，超时和原始错误不泄露", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  let counter = 0;
  const sdk = { on: (_event: string, fn: () => void) => { const id = String(++counter); listeners.set(id, fn); return id; }, off: (_event: string, id: string) => listeners.delete(id), share: vi.fn() } as unknown as TikTokMinisSDK;
  const outcome = vi.fn();
  const off = registerTikTokShare(sdk, { title: "old" }, outcome);
  const stale = listeners.get("1")!;
  off(); stale();
  expect(listeners.size).toBe(0);
  expect(sdk.share).not.toHaveBeenCalled();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const waiting = shareWithTikTok(sdk, { title: "new" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await waiting).toEqual({ status: "failed" });
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "share_timeout" }));
  vi.mocked(sdk.share!).mockImplementation((callback) => callback({ error: { error_msg: "token=secret https://example.com/private?signature=secret" } }));
  expect(await shareWithTikTok(sdk, { title: "new" })).toEqual({ status: "failed" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});

it("插屏首次等待 60 秒，后续保持 180 秒冷却和全屏互斥", () => {
  vi.useFakeTimers();
  const gate = new FullscreenAdGate();
  expect(gate.acquire(true)).toBeUndefined();
  vi.advanceTimersByTime(30_000);
  expect(gate.acquire(true)).toBeUndefined();
  vi.advanceTimersByTime(29_999);
  expect(gate.acquire(true)).toBeUndefined();
  vi.advanceTimersByTime(1);
  const close = gate.acquire(true)!;
  expect(close).toBeTypeOf("function");
  expect(gate.acquire(false)).toBeUndefined();
  close();
  vi.advanceTimersByTime(179_999);
  expect(gate.acquire(true)).toBeUndefined();
  vi.advanceTimersByTime(1);
  gate.acquire(false)!();
  expect(gate.acquire(true)).toBeUndefined();
  vi.advanceTimersByTime(180_000);
  expect(gate.acquire(true)).toBeTypeOf("function");
});

it("插屏只记录成功展示且关闭后解绑，错误不发奖、不卡住", async () => {
  let close!: () => void;
  const shown = vi.fn();
  const ad = { show: vi.fn(async () => {}), onClose: (fn: () => void) => { close = fn; }, onError: vi.fn(), offClose: vi.fn(), offError: vi.fn() };
  const sdk = { canIUse: () => true, createInterstitialAd: () => ad } as unknown as TikTokMinisSDK;
  const result = showInterstitial(sdk, "slot", shown);
  await Promise.resolve();
  expect(shown).toHaveBeenCalledOnce();
  close(); await result;
  expect(ad.offClose).toHaveBeenCalledWith(close);
  expect(ad.offError).toHaveBeenCalledOnce();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ad.show.mockRejectedValueOnce(new Error("no fill"));
  await showInterstitial(sdk, "slot", shown);
  expect(shown).toHaveBeenCalledOnce();
});

it("原生和网页生命周期合并去重，卸载后解绑不会恢复视频", () => {
  const callbacks = new Map<string, () => void>();
  const sdk = { on: (event: string, fn: () => void) => { callbacks.set(event, fn); return event; }, off: vi.fn() } as unknown as TikTokMinisSDK;
  const listener = vi.fn();
  const off = observeVisibility(sdk, listener);
  callbacks.get("minis.hide")!(); callbacks.get("minis.hide")!();
  callbacks.get("minis.show")!();
  expect(listener.mock.calls).toEqual([[false], [true]]);
  off(); callbacks.get("minis.show")!();
  expect(sdk.off).not.toHaveBeenCalled(); // 只取消当前订阅，页面级证据继续保留。
  expect(listener).toHaveBeenCalledTimes(2);
});

it("沉浸导航将物理像素换成 CSS 安全区并在卸载时恢复", () => {
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
  const sdk = { getMenuButtonBoundingClientRect: () => ({ top: 72, bottom: 180, height: 108 }), getDeviceInfo: () => ({ bottomHeight: 90 }), setNavigationBarColor: vi.fn() } as unknown as TikTokMinisSDK;
  const off = installImmersiveNavigation(sdk);
  expect(document.documentElement.style.getPropertyValue("--minis-top")).toBe("68px");
  expect(document.documentElement.style.getPropertyValue("--minis-menu-top")).toBe("24px");
  expect(document.documentElement.style.getPropertyValue("--minis-menu-height")).toBe("36px");
  expect(document.documentElement.style.getPropertyValue("--minis-bottom")).toBe("30px");
  off();
  expect(document.documentElement.style.getPropertyValue("--minis-top")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--minis-menu-top")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--minis-menu-height")).toBe("");
});


it("未确认展示的关闭不补造插屏曝光，拒绝后也不计展示", async () => {
  let close!: () => void;
  let fail!: (error: unknown) => void;
  const shown = vi.fn();
  const sdk = { canIUse: () => true, createInterstitialAd: () => ({
    show: () => new Promise<void>(() => {}),
    onClose: (fn: () => void) => { close = fn; },
    onError: (fn: (error: unknown) => void) => { fail = fn; },
  }) } as unknown as TikTokMinisSDK;
  const pending = showInterstitial(sdk, "slot", shown);
  close(); close(); await pending;
  expect(shown).not.toHaveBeenCalled();
  const rejected = showInterstitial(sdk, "another-slot", shown);
  fail({ error_msg: "no fill" }); close(); await rejected;
  expect(shown).not.toHaveBeenCalled();
});
