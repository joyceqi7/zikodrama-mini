import { adErrorPolicy } from "../config/adErrorPolicy";
import type { AdFailureFacts, AdMetricDetails, AdObservation, AdObserver } from "./adMetrics";
import { logClientEvent, safeErrorMessage } from "./clientLog";

/** AdErrorEvent 是广告专用日志合同；没有通用事件类型、原始对象或历史数组。 */
export interface AdErrorEvent {
  /** id 复用广告统计调用键，便于在日志服务关联同一次尝试。 */
  id: string;
  /** ad 只包含广告入口、阶段与错误码等有限字段。 */
  ad: AdMetricDetails;
  /** failure 是一次失败的脱敏现场，统计接口不接收该字段。 */
  failure: AdFailureFacts;
}

/** AdErrorReporter 独立发送广告错误；不持久化、不重试、不触发登录或阻塞广告。 */
export class AdErrorReporter {
  private subject = "";
  private generation = 0;
  private queue: AdErrorEvent[] = [];
  private timer?: number;
  private sending = false;
  private nextSendAt = 0;
  private overflowReported = false;

  /** constructor 注入广告专用发送入口；发送失败只记本地日志，避免递归上报。 */
  constructor(private readonly send: (events: AdErrorEvent[]) => Promise<unknown>) {}

  /** identify 在凭据安装完成后绑定主体；失效或换号丢弃旧现场和旧回调。 */
  identify(subject: string): void {
    if (subject === this.subject) return;
    this.subject = subject;
    this.generation++;
    this.queue = [];
    this.overflowReported = false;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** capture 仅接收当前主体每次调用的首个真实失败；正常、取消和本地跳过不发送。 */
  capture(metadata: Omit<AdMetricDetails, keyof AdObservation>, id: string): AdObserver {
    const generation = this.generation;
    let recorded = false;
    return observation => {
      if (recorded || generation !== this.generation || !this.subject || observation.kind !== "ad_failure" || !observation.failure) return;
      recorded = true;
      if (this.queue.length >= adErrorPolicy.queueSize) {
        if (!this.overflowReported) logClientEvent("warn", "ad_error_queue_full", { error: "Ad error dropped because the pending queue is full" });
        this.overflowReported = true;
        return;
      }
      const { stage, reason, errorCode, subErrorCode, innerErrorCode } = observation;
      this.queue.push({ id, ad: { ...metadata, stage, reason, errorCode, subErrorCode, innerErrorCode }, failure: { ...observation.failure } });
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.timer !== undefined || this.sending || !this.queue.length || !this.subject) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(adErrorPolicy.batchDelayMs, this.nextSendAt - performance.now()));
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0, adErrorPolicy.batchSize);
    this.overflowReported = false;
    this.sending = true;
    this.nextSendAt = performance.now() + adErrorPolicy.minIntervalMs;
    try {
      await this.send(batch);
    } catch (error) {
      // 现场允许丢失；不能因日志接口故障增加重试流量或递归产生远端错误日志。
      this.nextSendAt = performance.now() + adErrorPolicy.failureBackoffMs;
      logClientEvent("warn", "ad_error_batch_dropped", { error: safeErrorMessage(error) });
    } finally {
      this.sending = false;
      this.schedule();
    }
  }

  /** dispose 只清理内存与定时器，不在退出时补发请求。 */
  dispose(): void { this.identify(""); }
}
