import type { RewardedVideoAd, TikTokMinisSDK } from "./types";
import { platformErrorCodes, platformErrorMessage } from "./errors";
import { logClientEvent } from "../../observability/clientLog";

/** AdDiagnosticEvent 只保留测试序号、公开广告位、阶段、数值错误码和单调时钟耗时。 */
export interface AdDiagnosticEvent {
  /** attempt 是当前容器内的创建调用序号。 */
  attempt: number;
  /** kind 区分激励和插屏。 */
  kind: "rewarded" | "interstitial" | "unknown";
  /** adUnitId 必须来自当前测试应用服务端的真实配置。 */
  adUnitId: string;
  /** source 保留实际回调来源，不将 onError 擅自归类为创建或展示错误。 */
  source: "create_call" | "instance_returned" | "create_throw" | "setup_throw" | "show_call" | "show_resolved" | "show_rejected" | "onError" | "onClose" | "show_unconfirmed" | "close_unconfirmed" | "unhandled_rejection";
  /** elapsedMs 是从该次创建调用起算的耗时。 */
  elapsedMs: number;
  /** showCalled 说明观察到错误前是否已经调用过 show，不证明错误来自 show。 */
  showCalled?: boolean;
  /** observedAfterCreates 为无法归属实例的全局拒绝保留观察时累计调用数，不假称失败实例序号。 */
  observedAfterCreates?: number;
  /** errorCode 是官方数值码；未知原始对象不进入日志。 */
  errorCode?: string;
  /** subErrorCode 是官方可选数值子码。 */
  subErrorCode?: string;
  /** errorMessage 只提取并脱敏 SDK 消息，不序列化扩展对象。 */
  errorMessage?: string;
  /** isEnded 只保留明确布尔值，缺失时不推断完播。 */
  isEnded?: boolean;
}

interface DiagnosticInstance {
  ad: RewardedVideoAd;
  terminal: boolean;
  showCalled: boolean;
  emit(source: AdDiagnosticEvent["source"], error?: unknown, isEnded?: boolean): void;
  finish(): void;
}

/** AdDiagnosticRunner 只供单独的真机测试包使用；不调用领奖、广告事实或业务事件回传。 */
export class AdDiagnosticRunner {
  private sequence = 0;
  private stopped = false;
  private runningBurst = false;
  private createOnlyUsed = false;
  private activeShow = false;
  private disposed = false;
  private listeners: Array<() => void> = [];
  private lastCreated?: DiagnosticInstance;
  private readonly onUnhandled = (event: PromiseRejectionEvent) => {
    if (!this.createOnlyUsed || this.disposed) return;
    const codes = platformErrorCodes(event.reason);
    if (!codes.errorCode) return;
    // 官方 SDK 的监听注册可能产生未交给 onError 的拒绝；全局事件不含公开实例标识，不能虚构归属。
    this.stopped = true;
    this.observe({ attempt: 0, kind: "unknown", adUnitId: "", source: "unhandled_rejection", elapsedMs: 0,
      observedAfterCreates: this.sequence, ...codes, errorMessage: platformErrorMessage(event.reason, "SDK error").slice(0, 300) });
  };

  /** constructor 使用真实 SDK；注入观察者只接收脱敏测试事实。 */
  constructor(private readonly sdk: TikTokMinisSDK, private readonly observe: (event: AdDiagnosticEvent) => void) {
    window.addEventListener("unhandledrejection", this.onUnhandled);
  }

  /** busy 在原生结果未确认时保持互斥；停止测试不会强行释放广告。 */
  get busy(): boolean { return this.runningBurst || this.activeShow; }

  /** requiresReopen 表示创建专测留下未展示实例，必须关闭并重进 Mini 后再测其他模式。 */
  get requiresReopen(): boolean { return this.createOnlyUsed; }

  /** canProbe 只允许对创建专测末个实例探测一次公开 show 结果；不再新建广告。 */
  get canProbe(): boolean { return !this.disposed && !this.busy && !!this.lastCreated && !this.lastCreated.showCalled && !this.lastCreated.terminal; }

  /** stop 仅停止后续创建，不模拟关闭原生广告或丢弃迟到回调。 */
  stop(): void { this.stopped = true; }

  /** createBurst 限定最多 20 次同广告位创建；返回实例不等于加载成功，监听保留到容器退出。 */
  async createBurst(kind: "rewarded" | "interstitial", adUnitId: string, count: number, intervalMs: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 10000) throw new Error("Invalid diagnostic limits");
    this.assertAvailable();
    this.runningBurst = true;
    this.createOnlyUsed = true;
    this.stopped = false;
    try {
      for (let index = 0; index < count && !this.stopped && !this.disposed; index++) {
        this.lastCreated = this.create(kind, adUnitId);
        // 给桥接回调交付机会；异步错误停止后续调用，旧实例监听仍保留以归属迟到错误。
        if (!this.stopped) await new Promise(resolve => window.setTimeout(resolve, intervalMs));
      }
    } finally { this.runningBurst = false; }
  }

  /** showOnce 沿官方 create→监听→show 流程单次测试；不自动继续广告，也不申请奖励。 */
  showOnce(kind: "rewarded" | "interstitial", adUnitId: string): void {
    this.assertAvailable();
    this.stopped = false;
    this.activeShow = true;
    let record: ReturnType<AdDiagnosticRunner["create"]>;
    try { record = this.create(kind, adUnitId); }
    catch (error) { this.activeShow = false; throw error; }
    if (!record || record.terminal) { this.activeShow = false; return; }
    this.showRecord(record);
  }

  /** probeLastCreated 通过公开 show 暴露 SDK 延迟转发的初始化错误；成功时会打开一条原生广告。 */
  probeLastCreated(): void {
    if (!this.canProbe) throw new Error("No unshown diagnostic instance is available");
    this.activeShow = true;
    this.showRecord(this.lastCreated!);
  }

  private showRecord(record: DiagnosticInstance): void {
    record.showCalled = true;
    record.emit("show_call");
    const timeout = window.setTimeout(() => {
      if (!record.terminal) record.emit("show_unconfirmed");
      // 超时仅记录未知，禁止用测试超时解除真实原生广告互斥。
    }, 15000);
    this.listeners.push(() => window.clearTimeout(timeout));
    try {
      const shown = record.ad.show();
      Promise.resolve(shown).then(() => {
        window.clearTimeout(timeout);
        record.emit("show_resolved");
        if (!record.terminal) {
          const closeTimeout = window.setTimeout(() => { if (!record.terminal) record.emit("close_unconfirmed"); }, 300000);
          this.listeners.push(() => window.clearTimeout(closeTimeout));
        }
      }, error => {
        record.finish();
        this.stopped = true;
        record.emit("show_rejected", error);
      });
    } catch (error) {
      record.finish();
      this.stopped = true;
      record.emit("show_rejected", error);
    }
  }

  /** dispose 仅在容器退出时解绑监听；不调用未被官方文档定义的销毁或关闭方法。 */
  dispose(): void {
    this.disposed = true;
    this.stopped = true;
    window.removeEventListener("unhandledrejection", this.onUnhandled);
    for (const cleanup of this.listeners.splice(0)) {
      try { cleanup(); } catch (error) { logClientEvent("warn", "ad_diagnostic_cleanup_failed", platformErrorCodes(error)); }
    }
  }

  private assertAvailable(): void {
    if (this.disposed || this.busy || this.createOnlyUsed) throw new Error("Close and reopen the diagnostic Mini before starting another test");
  }

  private create(kind: "rewarded" | "interstitial", adUnitId: string): DiagnosticInstance | undefined {
    const capability = kind === "rewarded" ? "createRewardedVideoAd" : "createInterstitialAd";
    if (!adUnitId.trim() || !this.sdk.canIUse?.(capability)) throw new Error("Advertising capability unavailable");
    const startedAt = performance.now();
    const record = { ad: undefined as unknown as RewardedVideoAd, terminal: false, showCalled: false,
      emit: (_source: AdDiagnosticEvent["source"], _error?: unknown, _isEnded?: boolean) => {},
      finish: () => { if (!record.terminal && record.showCalled) this.activeShow = false; record.terminal = true; } };
    const attempt = ++this.sequence;
    record.emit = (source, error, isEnded) => {
      if (this.disposed) return;
      try { this.observe({ attempt, kind, adUnitId, source, elapsedMs: Math.round(performance.now() - startedAt), showCalled: record.showCalled,
        ...(error === undefined ? {} : { ...platformErrorCodes(error), errorMessage: platformErrorMessage(error, "SDK error").slice(0, 300) }), ...(isEnded === undefined ? {} : { isEnded }) }); }
      catch { logClientEvent("warn", "ad_diagnostic_observer_failed", { error: "Diagnostic observer failed" }); }
    };
    record.emit("create_call");
    try {
      record.ad = kind === "rewarded" ? this.sdk.createRewardedVideoAd({ adUnitId }) : this.sdk.createInterstitialAd!({ adUnitId });
      record.emit("instance_returned");
    } catch (error) { this.stopped = true; record.emit("create_throw", error); return; }
    const onError = (error: unknown) => {
      record.finish();
      this.stopped = true;
      record.emit("onError", error);
    };
    const onClose = (result: { isEnded?: boolean } | undefined) => {
      record.finish();
      record.emit("onClose", undefined, typeof result?.isEnded === "boolean" ? result.isEnded : undefined);
    };
    // 即便注册过程部分失败，也要在退出时尝试解绑已经安装的监听。
    this.listeners.push(() => record.ad.offError?.(onError), () => record.ad.offClose?.(onClose));
    try { record.ad.onError(onError); record.ad.onClose(onClose); }
    catch (error) { this.stopped = true; record.terminal = true; record.emit("setup_throw", error); }
    return record;
  }
}
