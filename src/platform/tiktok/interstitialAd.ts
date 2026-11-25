import type { AdIntent } from "./adIntent";
import type { AdObserver } from "../../observability/adMetrics";
import type { TikTokMinisSDK } from "./types";
import { logClientEvent } from "../../observability/clientLog";
import { platformErrorMessage } from "./errors";
import { adPolicy } from "../../config/adPolicy";
import { lastFullscreenAdEndedAt, showFullscreenAd } from "./fullscreenAd";

// 单调时刻仅在当前页面共享；Storage 只保存曾尝试的标记，不跨页面复用时间原点。
const pageIntervals = new WeakMap<Storage, Map<string, { lastAttempt: number }>>();

/** FullscreenAdGate 为首页/暂停插屏与激励广告提供同一互斥锁和冷却时钟。 */
export class FullscreenAdGate {
  private busy = false;
  private interval = { lastAttempt: -Infinity };
  private readonly startedAt = performance.now();
  /** constructor 在当前页面按应用共享间隔；有旧尝试标记的新页面保守等待一个完整间隔。 */
  constructor(private readonly applicationCode?: string) {
    if (!applicationCode) return;
    try {
      const attempted = !!sessionStorage.getItem(`minis-fullscreen-ad:${applicationCode}`);
      let byApplication = pageIntervals.get(sessionStorage);
      if (!byApplication) { byApplication = new Map(); pageIntervals.set(sessionStorage, byApplication); }
      this.interval = (attempted ? byApplication.get(applicationCode) : undefined) ?? { lastAttempt: attempted ? performance.now() : -Infinity };
      byApplication.set(applicationCode, this.interval);
    }
    catch (error) { logClientEvent("warn", "ad_interval_read_failed", { error: platformErrorMessage(error, "Ad interval unavailable") }); }
  }
  private recordAttempt(): void {
    this.interval.lastAttempt = performance.now();
    if (!this.applicationCode) return;
    try { sessionStorage.setItem(`minis-fullscreen-ad:${this.applicationCode}`, "1"); }
    catch (error) { logClientEvent("warn", "ad_interval_write_failed", { error: platformErrorMessage(error, "Ad interval unavailable") }); }
  }
  /** acquire 按 interstitial 区分插屏与激励并申请页面互斥锁。
   * 插屏宽限和间隔采用 adPolicy，传入 sdk 后将迟到的原生终止时间纳入间隔计算；激励仅做页面互斥。
   * 成功返回释放锁并重置尝试时钟的函数，拒绝返回 undefined；原生请求互斥和失败退避由调用层维护。
   */
  acquire(interstitial: boolean, sdk?: TikTokMinisSDK): (() => void) | undefined {
    const lastAttempt = Math.max(this.interval.lastAttempt, lastFullscreenAdEndedAt(sdk));
    if (this.busy || (interstitial && (performance.now() - this.startedAt < adPolicy.interstitialStartupDelayMs || performance.now() - lastAttempt < adPolicy.interstitialIntervalMs))) return;
    this.busy = true;
    this.recordAttempt();
    return () => { this.busy = false; this.recordAttempt(); };
  }
  /** isBusy 阻止广告期间自动恢复剧集。 */
  isBusy(): boolean { return this.busy; }
}

/** showInterstitial 只报告官方 show 成功，关闭不产生奖励；超时恢复调用方并保留原生请求互斥。 */
export async function showInterstitial(sdk: TikTokMinisSDK | undefined, adUnitId: string, onShown: () => void, observe?: AdObserver, intent?: AdIntent): Promise<void> {
  await showFullscreenAd(sdk, adUnitId, "interstitial", onShown, undefined, observe, intent);
}
