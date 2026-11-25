import type { PostbackScene } from "./postback";

/** AdMetricKind 是广告调用的可观察阶段，与 TikTok 业务事件回传分开计数。 */
export type AdMetricKind = "ad_trigger" | "ad_create" | "ad_created" | "ad_request" | "ad_shown" | "ad_complete" | "ad_closed" | "ad_cancelled" | "ad_failure" | "ad_skipped" | "ad_show_unknown" | "ad_close_unknown";
/** AdObservation 由统一 SDK 封装输出，不包含原始 SDK 对象或用户身份。 */
export interface AdObservation {
  /** kind 区分调用阶段；同一次广告各阶段最多一次。 */
  kind: AdMetricKind;
  /** stage 保留错误及超时所处阶段，不能仅凭错误码推断。 */
  stage: "capability" | "gate" | "create" | "setup" | "show" | "callback" | "close" | "destroy";
  /** reason 是固定分类，未知 SDK 错误不猜测填充率原因。 */
  reason?: string;
  /** errorCode 是官方数值错误码。 */
  errorCode?: string;
  /** subErrorCode 是官方数值子码。 */
  subErrorCode?: string;
  /** innerErrorCode 独立保留官方内部码，不能覆盖子码。 */
  innerErrorCode?: string;
  /** elapsedMs 是本次调用开始后的单调时钟耗时。 */
  elapsedMs?: number;
  /** showElapsedMs 只在已调用 show 后提供，用于请求至展示的分位数。 */
  showElapsedMs?: number;
  /** evidence 区分展示 Promise 和完播补证，不把普通关闭当曝光。 */
  evidence?: "show_promise" | "completed_close";
  /** timeline 关联关闭、展示和结果的单调时间，只进入服务端诊断日志。 */
  timeline?: AdTimeline;
  /** failure 仅随失败事件传到日志入口，不存入统计库。 */
  failure?: AdFailureFacts;
}
/** AdMetricDetails 关联业务入口及公开构建信息，所有标识保持字符串。 */
export interface AdMetricDetails extends Omit<AdObservation, "kind" | "failure" | "timeline"> {
  /** adType 区分激励和插屏。 */
  adType: "rewarded" | "interstitial";
  /** adUnitId 是实际传给 SDK 的广告位。 */
  adUnitId: string;
  /** scene 固定本次业务入口，不携带页面 URL。 */
  scene: PostbackScene;
  /** clientVersion 是 Mini 构建修订。 */
  clientVersion: string;
  /** os 是官方公开系统信息，不解析或上传完整 UA。 */
  os: "ios" | "android" | "unknown";
  /** tiktokVersion 是官方公开客户端版本，无法取得时明确标为 unknown。 */
  tiktokVersion: string;
}
/** AdObserver 只用于采集；实现异常不能改变广告与奖励结果。 */
export type AdObserver = ((observation: AdObservation) => void) & {
  /** attemptId 复用指标事实键，供前后广告关联。 */
  readonly attemptId?: string;
  /** timelineScope 仅在内存中标识同一指标主体，切换后不得关联上一主体的调用。 */
  readonly timelineScope?: object;
  /** nextAttempt 为静默恢复的新原生调用分配独立事实键，保留业务场景与当前主体隔离。 */
  readonly nextAttempt?: () => AdObserver;
};

/** AdTimelinePoint 是同一 WebView 内某个观测点的单调时间与可见状态。 */
export interface AdTimelinePoint {
  /** atMs 是相对当前 WebView 时间原点的毫秒数，不能跨 WebView 比较。 */
  atMs: number;
  /** documentVisibility 是网页可见状态，包含 pagehide。 */
  documentVisibility: "visible" | "hidden";
  /** nativeVisibility 是最后收到的宿主信号，不能证明广告环境就绪。 */
  nativeVisibility: "unknown" | "visible" | "hidden";
  /** prerendering 是浏览器明确报告的预渲染状态。 */
  prerendering: boolean;
}

/** AdLifecycleEvent 保留宿主事件或网页状态变化的观测顺序。 */
export interface AdLifecycleEvent extends AdTimelinePoint {
  /** source 标明信号来源；宿主重复发出的信号也保留。 */
  source: "document" | "minis.show" | "minis.hide" | "minis.destroy";
}

/** AdTimeline 复用同一调用的阶段事实键；只有展示请求携带前次调用及其关闭后区间。 */
export interface AdTimeline extends AdTimelinePoint {
  /** request 只在实际调用 show 前记录。 */
  request?: {
    /** userInitiated 区分手动重试和自动衔接。 */
    userInitiated: boolean;
    /** previousAttemptId 是同主体、同 SDK 的上一条实际 show 调用 ID。 */
    previousAttemptId?: string;
    /** previousCloseAtMs 是前次 onClose 的单调时间；未观察到关闭时省略。 */
    previousCloseAtMs?: number;
    /** lifecycle 保存前次关闭之后、这次 show 之前观测到的有界事件序列。 */
    lifecycle?: AdLifecycleEvent[];
    /** lifecycleTruncated 表示该区间有更早的观测事件已被覆盖。 */
    lifecycleTruncated?: boolean;
  };
}

/** AdFailureFacts 是失败当刻的固定字段，只进入服务端日志，不含历史数组。 */
export interface AdFailureFacts {
  /** error 是截断且脱敏的 SDK 错误详情。 */
  error: string;
  /** innerError 独立保留脱敏内部错误详情。 */
  innerError?: string;
  /** showDocument 是调用 show 前的网页状态；未调用时省略。 */
  showDocument?: "visible" | "hidden";
  /** showNative 是调用 show 前最后收到的宿主状态；unknown 不证明前台。 */
  showNative?: "visible" | "hidden" | "unknown";
  /** showPrerender 是调用 show 前浏览器明确给出的预渲染状态。 */
  showPrerender?: boolean;
  /** errorDocument 是失败当刻的网页状态。 */
  errorDocument: "visible" | "hidden";
  /** errorNative 是失败当刻最后收到的宿主状态。 */
  errorNative: "visible" | "hidden" | "unknown";
  /** errorPrerender 是失败当刻浏览器明确给出的预渲染状态。 */
  errorPrerender: boolean;
  /** shown 表示本次已获展示证明，不能推断宿主其他广告状态。 */
  shown: boolean;
  /** userInitiated 区分手动重试和自动触发。 */
  userInitiated: boolean;
  /** lockOwnerId 是处理本次错误、释放锁之前的本地持有者。 */
  lockOwnerId?: string;
  /** previousAttemptId 是同 SDK 上前一次实际调用 show 的指标键。 */
  previousAttemptId?: string;
  /** previousRelease 是前次本地释放原因；未释放为 pending，不代表宿主状态。 */
  previousRelease?: AdReleaseReason | "pending";
  /** previousCloseMs 是距前次收到 onClose 的毫秒数；未收到时省略。 */
  previousCloseMs?: number;
}

/** AdReleaseReason 只说明本地互斥的释放依据，不能代替原生关闭。 */
export type AdReleaseReason = "create_failed" | "setup_failed" | "show_rejected" | "active_conflict" | "closed" | "destroyed" | "container_unavailable" | "not_visible" | "stale_intent";
