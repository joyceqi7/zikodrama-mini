import { AdErrorReporter } from "../observability/adErrors";
import { timePolicy } from "../config/timePolicy";
import type { AdMetricDetails, AdObserver } from "../observability/adMetrics";
import { captureAdIntent, type AdIntent } from "../platform/tiktok/adIntent";
import { remainingServerTime } from "../domain/serverTime";
import { userMessage } from "../api/userMessage";
import { getVisibilitySnapshot, observeVisibility } from "../platform/tiktok/lifecycle";
import { ensureTikTokSDK } from "../platform/tiktok/sdkReady";
import { PlaybackCache } from "./playbackCache";
import { createPublicHomeCache, createPublicRankingCache } from "./publicHomeCache";
import { coverLoader } from "../components/coverLoader";
import { miniBuildVersion } from "../observability/postback";
import { miniAppVersion } from '../config/miniVersion';
import type { PostbackScene } from "../observability/postback";
import { MetricCollector, createMetricID } from "../observability/metrics";
import { OfficialPreloader } from "../player/preload";
import { officialPlayerOptions } from "../player/tiktokMinisPlayerEngine";
import { DirectVePlayerAdapter } from "../player/vePlayerEngine";
import { takeInitialAppConfig } from "./initialAppConfig";
import type { PlaybackSource } from "../player/playbackEngine";
import { FullscreenAdGate, showInterstitial } from "../platform/tiktok/interstitialAd";
import { isFullscreenAdBlockingPlayback } from "../platform/tiktok/fullscreenAd";
import { currentApplicationProfile } from "../config/applicationProfile";
import { PendingClaimStore, retryPendingClaims } from "../domain/pendingClaims";
import { PendingAdShowStore } from "../domain/pendingAdShows";
import { createRewardClaim } from "../domain/rewardClaim";
import { LocalLibraryStore } from "../domain/localLibrary";
import { browserStorage, createMemoryStorage } from "../domain/browserStorage";
import { text } from "../copy";
import type {
  AccessOffer,
  AdExperience,
  BootstrapInput,
  SessionResult,
  AppConfig,
  AdShowConfirmation,
  EntryAdStatus,
  ClaimResult,
  DiscoveryQuery,
  AdShow,
  LaunchTarget,
  PlaybackEntry,
  PlaybackEntryInput,
  MiniDramaApi,
  RewardClaim,
  VIPState,
} from "../domain/types";
import { ApiError, HttpMiniDramaApi, identityChangedError } from "../api/httpMiniDramaApi";
import type { PlaybackEngine } from "../player/playbackEngine";
import {
  TikTokMinisPlayerEngine,
} from "../player/tiktokMinisPlayerEngine";
import type { TikTokMinisPlayerAdapter } from "../player/tiktokMinisPlayerAdapter";
import { productionTikTokMinisPlayerAdapter } from "../player/tiktokMinisPlayerAdapter";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import { requestSilentLoginCode } from "../platform/tiktok/login";
import { TikTokEventReporter, type PlaybackEventName } from "../platform/tiktok/events";
import type { DramaDetail } from "../domain/types";
import { readTikTokSystemInfo } from "../platform/tiktok/systemInfo";
import {
  showRewardedAd,
  type RewardedAdResult,
} from "../platform/tiktok/rewardedAd";
import {
  registerTikTokShare,
  type ShareOutcome,
  type SharePayload,
} from "../platform/tiktok/share";

const VISITOR_TOKEN_KEY = "tiktok_minis_visitor_token";

function visitorTokenStorageKey(applicationCode: string): string {
  return `${VISITOR_TOKEN_KEY}:${applicationCode}`;
}

function readVisitorToken(applicationCode: string): string | undefined {
  try {
    return localStorage.getItem(visitorTokenStorageKey(applicationCode)) || undefined;
  } catch (reason) {
    logClientEvent("warn", "visitor_token_read_failed", { error: safeErrorMessage(reason) });
    return undefined;
  }
}

function saveVisitorToken(applicationCode: string, token: string): void {
  if (!token) return;
  try {
    localStorage.setItem(visitorTokenStorageKey(applicationCode), token);
  } catch (reason) {
    // Storage 不可用时仍可在当前页面生命周期内使用 API 持有的凭据。
    logClientEvent("warn", "visitor_token_write_failed", { error: safeErrorMessage(reason) });
  }
}

const ALLOWED_LAUNCH_QUERY_KEYS = new Set([
  "campaignCode", "campaign_code", "campaign",
  "dramaId", "drama_id", "albumId", "album_id", "episodeId", "episode_id",
  "ttclid", "utm_source", "utm_medium", "utm_campaign", "utm_content",
]);

export function readLaunchQuery(search: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, rawValue] of new URLSearchParams(search).entries()) {
    const value = rawValue.trim();
    if (ALLOWED_LAUNCH_QUERY_KEYS.has(key) && value && value.length <= 512) result[key] = value;
  }
  return result;
}

/** RuntimeSessionState 仅封闭不完整身份；普通依赖故障不触发全局重新登录。 */
export type RuntimeSessionState = "ready" | "recovery_required";

/** EntitlementChange 描述已确认且属于当前主体的权益变化，供页面清理对应剧集授权缓存。 */
export interface EntitlementChange {
  /** cause 区分奖励到账与 VIP 待重新确认；后者必须清除页面中的播放许可缓存。 */
  cause?: "vip_recheck";
  /** revision 是当前 runtime 单调递增的权益通知版本。 */
  revision: number;
  /** applicationId 与 visitorId 一起隔离观众主体，不得写入日志。 */
  applicationId: string;
  /** visitorId 是服务端确认的内部观众标识。 */
  visitorId: string;
  /** identityGeneration 阻止换号期间迟到的通知应用到新页面。 */
  identityGeneration: number;
  /** rewardType 指明剧集解锁或 VIP 权益更新。 */
  rewardType: ClaimResult["rewardType"];
  /** dramaId 是剧集奖励影响的短剧；一次结算可能同时解锁它的后续多集。 */
  dramaId?: string;
  /** episodeId 标识本次奖励来源剧集，不等同于全部解锁范围。 */
  episodeId?: string;
  /** playback 复用奖励响应中的领奖目标集授权，供当前播放或相邻集预加载。 */
  playback?: import("../domain/types").PlayResolveResult;
  /** entryAdStatus 直接传递结算后的进度，后台补领不要求页面再查询一次。 */
  entryAdStatus?: import("../domain/types").EntryAdStatus;
  /** drama 携带服务端确认的完整选集状态，不由页面推断解锁集数。 */
  drama?: DramaDetail;
}

/** Runtime 统一协调官方 SDK、消费者 API 与当前观众的本地状态。 */
export interface Runtime {
  /** prefetchAppConfig 在界面挂载前读取公开配置，供启动和播放器共用，不发起身份认证。 */
  prefetchAppConfig?(): Promise<void>;
  /** getCachedHomeSections 同步读取公开展示缓存，不包含身份或播放权益。 */
  getCachedHomeSections?(): import("../domain/types").HomeSections | undefined;
  /** getCachedHomeCarousel 同步读取已缓存轮播，允许它早于其他首页区域展示。 */
  getCachedHomeCarousel?(): import("../domain/types").DramaSummary[] | undefined;
  /** getCachedHomeHot 同步读取已缓存热播，允许它早于分类榜展示。 */
  getCachedHomeHot?(): import("../domain/types").DramaSummary[] | undefined;
  /** getCachedHomeRankings 同步读取已缓存分类榜，不阻塞首屏推荐。 */
  getCachedHomeRankings?(): import("../domain/types").CategoryRankingSection[] | undefined;
  /** getCachedPublicCatalog 同步读取当前应用的首屏目录缓存。 */
  getCachedPublicCatalog?(): import("../domain/types").HomePayload | undefined;
  /** prefetchHome 在 React 挂载前启动公开首页请求；推荐返回时立即回调，不等待目录或登录。 */
  prefetchHome?(onSections?: (sections: import("../domain/types").HomeSections) => void): Promise<void>;
  /** whenPlatformReady 等待官方 SDK 脚本和初始化完成，供登录、导航和播放共用。 */
  whenPlatformReady?(): Promise<void>;
  /** loadHomeSections 独立读取轮播与热门，推荐故障不影响全部目录。 */
  loadHomeSections?(): Promise<import("../domain/types").HomeSections>;
  /** loadHomeCarousel 独立读取公开轮播。 */
  loadHomeCarousel?(): Promise<import("../domain/types").DramaSummary[]>;
  /** loadHomeHot 独立读取公开热播。 */
  loadHomeHot?(): Promise<import("../domain/types").DramaSummary[]>;
  /** loadHomeRankings 独立读取公开分类榜。 */
  loadHomeRankings?(): Promise<import("../domain/types").CategoryRankingSection[]>;
  /** getCachedHomeRankingCategories 同步读取轻量分类目录，旧版完整榜单缓存不会混入。 */
  getCachedHomeRankingCategories?(): import("../domain/types").HomeRankingCategory[] | undefined;
  /** loadHomeRankingCategories 只请求分类目录，不预取其他分类剧目。 */
  loadHomeRankingCategories?(): Promise<import("../domain/types").HomeRankingCategory[]>;
  /** getCachedHomeRankingPage 同步恢复指定分类的首屏，分页状态按分类隔离。 */
  getCachedHomeRankingPage?(tagId: string): import("../domain/types").HomeRankingPage | undefined;
  /** loadHomeRankingPage 按分类和游标读取当前页，默认每页二十部。 */
  loadHomeRankingPage?(tagId: string, input?: Pick<DiscoveryQuery, "cursor" | "limit">): Promise<import("../domain/types").HomeRankingPage>;
  /** resolvePlayback 复用当前应用与观众的短期预取授权；显式恢复仍走 API 重新验权。 */
  resolvePlayback?(dramaId: string, episodeId: string): Promise<import("../domain/types").PlayResolveResult>;
  /** getCachedPlayable 在前台同步读取当前观众的有效正片授权，剧场仍须通过当前播放门禁。 */
  getCachedPlayable?(dramaId: string, episodeId: string): import("../domain/types").PlayResolveResult | undefined;
  /** resolvePlaybackEntry 获取本次详情的广告状态；首次投放详情复用已确认的落地决策。 */
  resolvePlaybackEntry?(dramaId: string, episodeId: string): Promise<PlaybackEntry>;
  /** invalidatePlayback 在重试及权益刷新时撤销共享授权。 */
  invalidatePlayback?(): void;
  /** prefetchPlaybackInfo 提交当前观众已获授权的下一集，预取结果不参与起播判定。 */
  prefetchPlaybackInfo?(source: PlaybackSource): void;
  /** preloadMedia 接收官方已就绪媒资；预加载不授予起播权限。 */
  preloadMedia?(sources: PlaybackSource[], scene: 0 | 1): Promise<void>;
  /** canPreloadMedia 根据当前服务端播放通道判断是否能消费媒体预热。 */
  canPreloadMedia?(): boolean;
  /** resolvePlaybackBatch 用一次请求准备连续播放窗口中的相邻集决策。 */
  resolvePlaybackBatch?(dramaId: string, episodeIds: string[]): Promise<import("../domain/types").PlayResolveResult[]>;
  /** clearMediaPreload 离页或权益失效时取消旧候选。 */
  clearMediaPreload?(purge?: boolean): void;
  /** showInterstitialIfEligible 在执行时重新检查页面资格和全屏间隔。 */
  showInterstitialIfEligible?(eligible: () => boolean, scene?: "home_interstitial" | "pause_interstitial"): Promise<void>;
  /** isFullscreenAdActive 在有界的广告等待期禁止恢复视频；超时请求仍单独隔离，不能重复拉起广告。 */
  isFullscreenAdActive?(): boolean;
  /** getSessionState 返回当前身份是否完整可用。 */
  getSessionState?(): RuntimeSessionState;
  /** getSessionSubjectKey 只返回完整安装后的主体快照，语言重渲染不能提前公开安装中的账号。 */
  getSessionSubjectKey?(): string;
  /** subscribeSessionState 让全局界面在身份封闭后回到可重试的启动状态。 */
  subscribeSessionState?(listener: () => void): () => void;
  /** recoverSession 只由用户明确重试触发，合并并发请求并完整初始化会话。 */
  recoverSession?(): Promise<void>;
  /** subscribeEntitlements 通知直接领取和后台补领已经确认的当前主体权益变化。 */
  subscribeEntitlements?(listener: (change: EntitlementChange) => void): () => void;
  /** getEntitlementRevision 支持页面挂载时识别订阅前已完成的结算。 */
  getEntitlementRevision?(): number;
  /** getApplicationID 与 getVisitorID 一起校验权益通知是否属于当前主体。 */
  getApplicationID?(): string;
  // reportPlaybackEvent 转交官方中间事件，不参与播放授权或奖励判定。
  reportPlaybackEvent?(event: PlaybackEventName, drama: DramaDetail, episodeId: string): void;
  /** reportPlaybackComplete 仅由当前播放器结束回调触发运营完播统计。 */
  reportPlaybackComplete?(dramaId: string, episodeId: string): void;
  /** reportPlaybackQuality 记录不含媒资与位置的播放器质量事实。 */
  reportPlaybackQuality?(kind: "player_first_frame" | "player_switch" | "player_stall" | "player_autoplay_blocked" | "player_error"): void;
  /** clearPlaybackEventContext 离开播放页后移除剧集上下文，避免首页广告误绑上一部剧。 */
  clearPlaybackEventContext?(): void;
  /** api 始终通过 HTTP 请求服务端，目录和权益均以服务端结果为准。 */
  api: MiniDramaApi;
  /** localLibrary 按应用和当前 Visitor 隔离；身份确认前为空库，旧页补写须保留原 Store。 */
  localLibrary: LocalLibraryStore;
  /** bootstrap 合并并发启动，完成配置、身份安装与可信落地解析；VIP 查询和旧奖励补领独立恢复，播放仍须经过权益门禁。 */
  bootstrap(): Promise<void>;
  /** loadPublicCatalog 按搜索、分类和游标加载公开目录，不初始化个人库或授予播放权限。 */
  loadPublicCatalog?(input?: DiscoveryQuery): Promise<import("../domain/types").HomePayload>;
  /** getCachedPlaybackCover 同步读取当前主体与身份代次已确认的目标集海报；未命中或过期只返回空，不请求目录、不授予播放权限。 */
  getCachedPlaybackCover?(dramaId: string, episodeId: string): string;
  /** loadPlaybackCover 在身份就绪后按内部剧目和分集字符串 ID 读取目标海报，短期缓存按主体隔离；无图返回空字符串，不读取目录或授予播放权限，失败记录日志并拒绝。 */
  loadPlaybackCover?(dramaId: string, episodeId: string): Promise<string>;
  /** loadReviewHome 仅调用新增审核首页接口，命中前不挂载普通首页栏目。 */
  loadReviewHome?(): Promise<import("../domain/types").ReviewHome>;
  /** preparePlayback 按可信配置准备 Player；独立资源与 SDK 初始化并行，许可仍等待平台校验；官方通道等待身份安装但不等待落地或 VIP。只准备构造器，不授予播放权限或切换通道。 */
  preparePlayback?(): Promise<void>;
  /** getConfirmedEntryAdStatus 只复用当前用户展示确认返回的有效状态，不由本地累计次数。 */
  getConfirmedEntryAdStatus?(dramaId: string): EntryAdStatus | undefined;
  /** refreshBootstrap 显式重新换码并独立刷新配置，不调用旧聚合接口。 */
  refreshBootstrap(): Promise<void>;
  /** createPlaybackEngine 创建共用的官方 VePlayer 适配层。 */
  createPlaybackEngine(): PlaybackEngine;
  /** showRewardedAd 绑定领取主体；intent 在 create/show 前复核当前目标，没有 ClaimID 不启动无法安全结算的广告。 */
  showRewardedAd(adUnitId: string, claim?: RewardClaim, intent?: AdIntent): Promise<RewardedAdResult>;
  /** showEntryAd 使用 intent 校验当前页面，等待原生结果或返回 unknown；展示模式等待已产生的事实确认，只有明确完播可独立结算奖励。 */
  showEntryAd(claim: RewardClaim, requireShowConfirmation?: boolean, intent?: AdIntent): Promise<RewardedAdResult & { entryAdStatus?: EntryAdStatus }>;
  /** retryPendingAdShows 补报当前主体的事实，可指定场景；返回确认数量，失败保留原事件。 */
  retryPendingAdShows(scene?: string): Promise<number>;
  /** registerShare 监听原生分享入口并提供资料，返回清理函数阻止旧剧集回调。 */
  registerShare(
    payload: SharePayload,
    onOutcome: (result: ShareOutcome) => void,
  ): () => void;
  /** claimReward 按原 ClaimID 请求服务端结算，拒绝跨账号结果并保留未确认的待领取记录。 */
  claimReward(claim: RewardClaim): Promise<ClaimResult>;
  /** claimVIP 仅在用户点击领取后请求服务端激活，拒绝跨账号迟到响应。 */
  claimVIP(): Promise<VIPState>;
  /** retryPendingAdClaims 只补领当前完整身份的队列，返回本轮已确认的结算。 */
  retryPendingAdClaims(): Promise<ClaimResult[]>;
  /** hasPendingAdClaim 返回当前观众是否仍有未确认奖励。 */
  hasPendingAdClaim(): boolean;
  /** getAdExperience 返回服务端确认的 VIP 进度与可用广告入口。 */
  getAdExperience(): AdExperience;
  /** refreshAdExperience 用现有登录态查询 VIP；仅凭据失效才重新登录，失败保留恢复入口。 */
  refreshAdExperience(): Promise<void>;
  /** subscribeAdExperience 订阅当前观众的广告状态变化并返回退订函数。 */
  subscribeAdExperience(listener: () => void): () => void;
  /** watchVIPAd 按有效 Offer 展示官方激励广告，完整观看才结算；取消或 VIP 已生效返回 null，intent 约束等待期间的页面目标，vip_refresh_pending 表示等待权益刷新，ad_foreground_required 表示展示意图失效或等待前台恢复。 */
  watchVIPAd(offer?: AccessOffer, intent?: AdIntent): Promise<ClaimResult | null>;
  /** getLaunchTarget 返回服务端确认的剧集入口，未指定时返回 undefined。 */
  getLaunchTarget(): LaunchTarget | undefined;
  /** getApplicationBrand 返回当前应用的名称与公开图标。 */
  getApplicationBrand(): ApplicationBrand;
  /** getComplianceBaseURL 返回当前应用的合规页面基础地址。 */
  getComplianceBaseURL(): string;
  /** getVisitorID 返回已安装身份的内部观众标识，未安装时为空字符串。 */
  getVisitorID(): string;
}

export interface ApplicationBrand {
  name: string;
  logoUrl: string;
}

/** RewardedAdStepResult 区分广告拉起、完整观看和奖励确认；message 仅用于故障诊断。 */
export type RewardedAdStepResult =
  | { status: "completed"; claim: ClaimResult }
  | { status: "cancelled" }
  | { status: "unknown" }
  | { status: "unavailable"; message?: string; /** reason 保留前台门禁结果，供页面选择恢复入口。 */ reason?: Extract<RewardedAdResult, { status: "failed" }>["reason"] }
  | { status: "pending" }
  | { status: "rejected"; claim?: ClaimResult };

/** isRetryableClaimError 只有明确业务拒绝才删除记录；未知结果不能要求观众重看广告。 */
export function isRetryableClaimError(error: unknown): boolean {
  if (error instanceof ApiError) {
    const confirmedRejections: Record<string, readonly number[]> = {
      invalid_reward_claim: [400, 403, 409, 422],
      invalid_request: [400, 422],
      not_found: [404],
    };
    return !confirmedRejections[error.code ?? ""]?.includes(error.status);
  }
  return true;
}

/** executeVIPRewardedAd 仅在官方确认完播后结算，拉起失败保留原因且不生成奖励。 */
export async function executeVIPRewardedAd(
  claim: RewardClaim,
  showAd: (adUnitId: string) => Promise<RewardedAdResult>,
  claimCompleted: (claim: RewardClaim) => Promise<ClaimResult>,
): Promise<RewardedAdStepResult> {
  const adUnitId = claim.adUnitId.trim();
  if (!adUnitId) {
    return { status: "unavailable", message: "VIP rewarded ad unit is unavailable" };
  }
  const result = await showAd(adUnitId);
  if (result.status === "cancelled") {
    return { status: "cancelled" };
  }
  if (result.status === "unknown") return result;
  if (result.status !== "completed") {
    const message = result.status === "failed" ? result.message : "Rewarded ad capability or ad unit is unavailable";
    return { status: "unavailable", ...(message ? { message } : {}), ...(result.status === "failed" && result.reason ? { reason: result.reason } : {}) };
  }
  try {
    const settled = await claimCompleted(claim);
    if (settled.rewardType !== "vip_progress") {
      return { status: "rejected", claim: settled };
    }
    return { status: "completed", claim: settled };
  } catch (error) {
    return isRetryableClaimError(error)
      ? { status: "pending" }
      : { status: "rejected" };
  }
}

const EMPTY_AD_EXPERIENCE: AdExperience = {
  vipState: {
    active: false,
    adCount: 0,
    requiredCount: 1,
    progressDate: "",
  },
  monetizationPolicy: {
    status: "disabled",
    strategy: "episode_reward",
    freeEpisodeCount: 0,
    episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
    vip: {
      enabled: false,
      requiredAdCount: 1,
      delaySeconds: 0,
      title: "",
      content: "",
    },
  },
};

/** createRuntime 在所有环境使用官方 SDK 和真实 API；适配器参数仅提供依赖注入。 */
export function createRuntime(playerAdapter: TikTokMinisPlayerAdapter = productionTikTokMinisPlayerAdapter): Runtime {
  const applicationProfile = currentApplicationProfile();
  const earlyConfig = takeInitialAppConfig(applicationProfile);
  const api = earlyConfig?.api ?? new HttpMiniDramaApi(applicationProfile.apiBaseUrl);
  let initialConfigResponse = earlyConfig?.response;
  let initialLogin = earlyConfig?.login;
  let initialPlatformReady = initialLogin?.platformReady;
  const platformReadyForStartup = () => initialPlatformReady ?? ensureTikTokSDK();
  const homeCacheOptions = {
    scope: () => appConfig ? JSON.stringify([miniAppVersion(),appConfig.miniReview?.revision??0,appConfig.miniReview?.enabled??false,appConfig.miniReview?.episodeOnly??false]) : undefined,
    prepare: () => loadAppConfig(),
  };
  const publicHome = createPublicHomeCache(applicationProfile.tiktokAppId, applicationProfile.apiBaseUrl,
    () => api.homeCarousel(applicationProfile.tiktokAppId),
    () => api.homeHot(applicationProfile.tiktokAppId),
    // 完整榜单仅留给旧版展示快照；生产首页改用独立目录与单分类分页接口。
    async () => [],
    () => api.publicCatalog(applicationProfile.tiktokAppId, { limit: 20 }), homeCacheOptions);
  const publicRankings = createPublicRankingCache(applicationProfile.tiktokAppId, applicationProfile.apiBaseUrl,
    () => api.homeRankingCategories(applicationProfile.tiktokAppId),
    (tagId, input) => api.homeRankingPage(applicationProfile.tiktokAppId, tagId, input), homeCacheOptions);
  const metrics = new MetricCollector((events) => api.collectMetrics(events));
  const adErrors = new AdErrorReporter(events => api.reportAdErrors(events));
  let adSystemInfo: { platform?: string; version?: string } | undefined;
  const adMetrics = (adType: "rewarded" | "interstitial", adUnitId: string, scene: PostbackScene, id?: string): AdObserver => {
    // 宿主公开信息仍须校验类型和长度，诊断维度异常不能阻断广告或污染整个指标批次。
    const platform = typeof adSystemInfo?.platform === "string" ? adSystemInfo.platform.toLowerCase() : "";
    const version = typeof adSystemInfo?.version === "string" ? adSystemInfo.version : "";
    const metadata: Omit<AdMetricDetails, keyof import("../observability/adMetrics").AdObservation> = {
      adType, adUnitId, scene, clientVersion: miniBuildVersion(),
      os: platform === "ios" ? "ios" : platform === "android" ? "android" : "unknown",
      tiktokVersion: version.length <= 32 && /^[0-9]+(?:\.[0-9]+){0,4}$/.test(version) ? version : "unknown",
    };
    const metric = metrics.captureAd(metadata, id);
    const reportError = adErrors.capture(metadata, metric.attemptId!);
    const observe: AdObserver = observation => { metric(observation); reportError(observation); };
    return Object.assign(observe, { attemptId: metric.attemptId, timelineScope: metric.timelineScope,
      nextAttempt: () => adMetrics(adType, adUnitId, scene) });
  };
  let metricVisibilityInstalled = false;
  let systemInfoPromise: ReturnType<typeof readTikTokSystemInfo> | undefined;
  const readSystemInfo = () => {
    systemInfoPromise ??= readTikTokSystemInfo(window.TTMinis).then(info => { adSystemInfo = info; return info; });
    return systemInfoPromise;
  };
  const storage = browserStorage();
  let pendingClaims = new PendingClaimStore(
    storage,
    applicationProfile.tiktokAppId,
  );
  let pendingAdShows = new PendingAdShowStore(createMemoryStorage(), "uninitialized", () => api.serverNow());
  // 身份安装前只暴露本实例空库，禁止读取无法判断归属的旧设备共享分区。
  let localLibrary = new LocalLibraryStore(applicationProfile.tiktokAppId, "anonymous", createMemoryStorage());
  const preloader = new OfficialPreloader(playerAdapter);
  const playbackCache = new PlaybackCache();
  // 仅保存当前页面的目标海报，最多三十二项；详情复用现有在途请求，封面缓存不参与任何权益判断。
  const playbackCovers = new Map<string, { promise: Promise<string>; expiresAt: number; url?: string }>();
  // 初始官方字段仅作占位；启动确认身份和通道后才能预热或安装直连适配器。
  let playbackSDK: import("../domain/types").PlaybackSDKConfig = { provider: "tiktok_minis", channel: "byteplus" };
  let directAdapter: DirectVePlayerAdapter | undefined;
  const fullscreenAds = new FullscreenAdGate(applicationProfile.tiktokAppId);
  let interstitialAdUnitId = "";
  const eventReporter = new TikTokEventReporter(
    () => window.TTMinis,
    ({ id, event, outcome, details, occurredAt }) => metrics.recordTikTokPostback(id, event, outcome, details, occurredAt),
  );
  // 目录查询由播放预览与入剧广告共享，身份变化后的返回值不能进入新主体的事件上下文。
  const fetchDrama = api.drama.bind(api);
  const dramaRequests = new Map<string, ReturnType<typeof fetchDrama>>();
  api.drama = (id) => {
    const subject = sessionSubjectKey;
    const generation = identityGeneration;
    // 同一账号切走再切回也属于新代次，不能复用前一次身份仍在途的详情或封面。
    const key = JSON.stringify([subject, generation, id]);
    const existing = dramaRequests.get(key);
    if (existing) return existing;
    const request = fetchDrama(id).then(detail => {
      if (subject === sessionSubjectKey && generation === identityGeneration) eventReporter.rememberDrama(detail);
      return detail;
    }).finally(() => { if (dramaRequests.get(key) === request) dramaRequests.delete(key); });
    dramaRequests.set(key, request);
    return request;
  };
  const experienceListeners = new Set<() => void>();
  const sessionListeners = new Set<() => void>();
  const entitlementListeners = new Set<(change: EntitlementChange) => void>();
  let sessionState: RuntimeSessionState = "ready";
  /** sessionSubjectKey 在凭据和运行时均安装成功后更新；不在日志或本地库保存。 */
  let sessionSubjectKey = "";
  let entitlementRevision = 0;
  // VIP 响应只在发起后没有更晚权益事实时应用，防止领奖前的在途查询撤销刚到账的权益。
  let vipStateRevision = 0;
  let vipConfirmationOrder = 0;
  let vipExpiryTimer: number | undefined;
  // 初始化和用户明确重试共享单飞，避免连续点击产生多次官方换码。
  let sessionInitialization: Promise<void> | undefined;
  // 播放器只依赖完整身份，不能把可信目标解析的等待附加到 getPlayer 前。
  let identityInitialization: Promise<void> | undefined;
  let adExperience = EMPTY_AD_EXPERIENCE;
  let applicationBrand: ApplicationBrand = {
    name: applicationProfile.name,
    logoUrl: applicationProfile.logoUrl,
  };
  let complianceBaseURL = "";
  let launchTarget: LaunchTarget | undefined;
  let launchEntry: { entry: PlaybackEntry; subject: string; epoch: number; revision: number; at: number } | undefined;
  let appConfig: AppConfig | undefined;
  let configLoading: Promise<void> | undefined;
  let configConfirmed = false;
  let configGeneration = 0;
  let configHidden = !getVisibilitySnapshot().visible;
  // 首次宿主前台确认不重复请求配置；真正回到前台才撤销旧确认，公开首页与权益共用下一次读取。
  observeVisibility(undefined, visible => {
    if (!visible || configHidden) {
      configConfirmed = false;
      configGeneration += 1;
    }
    configHidden = !visible;
  });
  let currentOpenID = "";
  let sessionCampaign: SessionResult["campaign"];
  let initialized = false;
  const entryConfirmations = new Map<string, EntryAdStatus>();
  let visitorID = "";
  // applicationID 与 visitorID 一起确认业务主体，不能只用包内 AppID 推断身份。
  let applicationID = "";
  // identityGeneration 在实际换号时递增，阻止 A→B→A 期间迟到回调更新新页面状态。
  let identityGeneration = 0;
  /** ClaimOwner 固定广告或领取发起时的主体和存储引用，异步回调不能读取新账号分区。 */
  interface ClaimOwner {
    /** applicationID 是服务端确认的应用身份。 */
    applicationID: string;
    /** visitorID 是服务端确认的用户身份，不写入日志。 */
    visitorID: string;
    /** generation 区分换号前后的页面业务上下文。 */
    generation: number;
    /** store 始终指向原账号待领取分区。 */
    store: PendingClaimStore;
    /** showStore 始终指向广告发起主体的展示事实分区。 */
    showStore: PendingAdShowStore;
  }
  // 用稳定 ClaimID 关联，浅拷贝请求对象或再次点击广告不能覆盖原始归属。
  const claimOwners = new Map<string, ClaimOwner>();
  // 同一领取请求不能并发展示两次广告，避免取消回调清除另一轮广告的归属。
  const activeAdClaims = new Set<string>();
  const captureClaimOwner = (): ClaimOwner => ({
    applicationID, visitorID, generation: identityGeneration, store: pendingClaims, showStore: pendingAdShows,
  });
  const isSameSubject = (owner: ClaimOwner, other: ClaimOwner): boolean => Boolean(owner.visitorID) &&
    owner.applicationID === other.applicationID && owner.visitorID === other.visitorID;
  const isCurrentOwner = (owner: ClaimOwner): boolean => isSameSubject(owner, captureClaimOwner()) && owner.generation === identityGeneration;
  const assertClaimOwner = (owner: ClaimOwner): void => {
    if (isCurrentOwner(owner)) return;
    logClientEvent("warn", "reward_identity_changed", {
      flow: "reward_claim", stage: "identity_guard", outcome: "original_account_preserved",
    });
    throw identityChangedError();
  };
  let recoveryTimer: number | undefined;
  let recoveryDelay = 5_000;
  let recoveryRunning = false;
  let recoveryInstalled = false;
  const bootstrapInput = async (): Promise<BootstrapInput> => {
    const login = initialLogin;
    initialLogin = undefined;
    await platformReadyForStartup();
    // 公开版本诊断与登录并行，不增加广告展示前等待。
    void readSystemInfo();
    const input: BootstrapInput = {
      tiktokAppId: applicationProfile.tiktokAppId,
      visitorToken: readVisitorToken(applicationProfile.tiktokAppId),
      launchQuery: readLaunchQuery(window.location.search),
    };
    input.loginCode = await login?.consume() ?? await requestSilentLoginCode(window.TTMinis);
    return input;
  };

  /** publishAdExperience 只通知 UI；个别订阅者异常不能推翻已确认的身份或奖励事实。 */
  const publishAdExperience = (): void => {
    experienceListeners.forEach((listener) => {
      try { listener(); } catch (reason) {
        logClientEvent("warn", "ad_experience_listener_failed", { error: safeErrorMessage(reason) });
      }
    });
  };

  const setAdExperience = (next: AdExperience, notify = true) => {
    const previous = adExperience.vipState;
    const remaining = remainingServerTime(next.vipState);
    const unconfirmed = next.vipState.active && !!next.vipState.validUntil && (remaining === undefined || remaining <= 0);
    next = { ...next, refreshRequired: unconfirmed || (next.vipState === previous && next.refreshRequired === true) };
    if (!next.refreshRequired) next.refreshError = undefined;
    if (next.vipState !== previous) vipStateRevision += 1;
    adExperience = next;
    scheduleVIPExpiry();
    if (notify) publishAdExperience();
  };

  const setSessionState = (next: RuntimeSessionState): void => {
    if (sessionState === next) return;
    sessionState = next;
    if (next === "recovery_required") {
      playbackCache.clear();
      directAdapter?.clearMediaInfoCache();
    }
    if (next === "recovery_required" && recoveryTimer !== undefined) {
      window.clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    }
    logClientEvent(next === "ready" ? "info" : "warn", "runtime_session_state_changed", {
      flow: "identity", stage: "session_installation", outcome: next,
    });
    sessionListeners.forEach((listener) => {
      try { listener(); } catch (reason) {
        logClientEvent("warn", "session_listener_failed", { error: safeErrorMessage(reason) });
      }
    });
  };

  const publishEntitlement = (claim: Pick<ClaimResult, "rewardType"> & Partial<Pick<ClaimResult, "dramaId" | "episodeId" | "playback" | "entryAdStatus" | "drama">>, owner: ClaimOwner, cause?: EntitlementChange["cause"]): void => {
    if (!isCurrentOwner(owner)) return;
    playbackCache.clear(false);
    // 领奖只增加权益：仅失效业务授权，保留 Feed 列表和正在下载的下一集。
    // VIP 待重新确认时取消任务并释放媒体；账号切换由 applySession 独立清理。
    if (cause === "vip_recheck") {
      preloader?.clear(true);
      directAdapter?.clearMediaInfoCache();
    }
    const change: EntitlementChange = {
      revision: ++entitlementRevision, applicationId: owner.applicationID, cause,
      visitorId: owner.visitorID, identityGeneration: owner.generation,
      rewardType: claim.rewardType, dramaId: claim.dramaId || undefined, episodeId: claim.episodeId || undefined,
      playback: claim.playback,
      entryAdStatus: claim.entryAdStatus,
      drama: claim.drama,
    };
    // 结算响应已提供权威权益；逐条通知页面，不额外换码或全量刷新会话。
    entitlementListeners.forEach((listener) => {
      try { listener(change); } catch (reason) {
        logClientEvent("warn", "entitlement_listener_failed", { error: safeErrorMessage(reason) });
      }
    });
  };

  /** refreshAdExperience 只读取当前主体的权益；后台中断可取消读取，广告结算仍保留原键。 */
  let vipRefresh: Promise<void> | undefined;
  let vipRefreshAbort: AbortController | undefined;
  const refreshAdExperience = (): Promise<void> => {
    if (vipRefresh) return vipRefresh;
    const owner = captureClaimOwner();
    const abort = new AbortController();
    vipRefreshAbort = abort;
    const pending = (async () => {
      await loadAppConfig();
      const result = await api.vipState(abort.signal);
      if (abort.signal.aborted || !isCurrentOwner(owner)) return;
      const vipState = result.responseOrder !== undefined && result.responseOrder <= vipConfirmationOrder
        ? adExperience.vipState : result;
      setAdExperience({ ...adExperience, vipOffer: undefined, vipState });
    })().catch(reason => {
      // 回后台取消的是只读请求，不是业务失败；回前台会取得新时间基准与最新权益。
      if (abort.signal.aborted) return;
      logClientEvent("warn", "vip_state_refresh_failed", { error: safeErrorMessage(reason instanceof Error && reason.cause !== undefined ? reason.cause : reason) });
      if (isCurrentOwner(owner)) {
        adExperience = { ...adExperience, refreshRequired: true, refreshError: userMessage(reason, text("apiErrors.responseUnconfirmed")) };
        publishAdExperience();
      }
      throw reason;
    }).finally(() => {
      if (vipRefresh === pending) { vipRefresh = undefined; vipRefreshAbort = undefined; }
    });
    vipRefresh = pending;
    return pending;
  };

  /** expireVIP 仅标记状态待确认并请求服务端，不用客户端时钟撤销或延长权益。 */
  const expireVIP = (): void => {
    const state = adExperience.vipState;
    if (!state.active || !state.validUntil || adExperience.refreshRequired || (remainingServerTime(state) ?? 0) > 0) return;
    const owner = captureClaimOwner();
    setAdExperience({ ...adExperience, refreshRequired: true, refreshError: undefined });
    publishEntitlement({ rewardType: "vip_progress" }, owner, "vip_recheck");
    void refreshAdExperience().catch(() => { /* 刷新边界已记录实际错误，并保留手动恢复入口。 */ });
  };

  /** scheduleVIPExpiry 只为已确认且属于当前主体的截止点安装单次刷新，不复用设备日历。 */
  const scheduleVIPExpiry = (): void => {
    window.clearTimeout(vipExpiryTimer);
    vipExpiryTimer = undefined;
    const state = adExperience.vipState;
    const remaining = remainingServerTime(state);
    if (!state.active || !state.validUntil || adExperience.refreshRequired || remaining === undefined || remaining <= 0) return;
    const owner = captureClaimOwner();
    vipExpiryTimer = window.setTimeout(() => {
      vipExpiryTimer = undefined;
      if (!isCurrentOwner(owner)) return;
      expireVIP();
      scheduleVIPExpiry();
    }, Math.min(2_147_483_647, remaining));
  };

  /** applyAppConfig 安装公开配置；失败只影响配置加载，不撤销已安装身份。 */
  const applyAppConfig = async (result: AppConfig): Promise<void> => {
    if (result.tiktokAppId !== applicationProfile.tiktokAppId || (applicationID && applicationID !== result.applicationId)) {
      throw new ApiError("Application configuration does not match session", 200, "invalid_response");
    }
    if (!result.playbackSdk || !["tiktok_minis", "byteplus_web"].includes(result.playbackSdk.provider) ||
      result.playbackSdk.channel !== "byteplus" ||
      (result.playbackSdk.provider === "byteplus_web" && result.playbackSdk.capabilities?.mediaPreload !== false)) {
      logClientEvent("error", "app_playback_config_rejected", { error: "Invalid application playback configuration" });
      throw new Error(text("runtime.playerUnavailable"));
    }
    if (playbackSDK.provider !== result.playbackSdk.provider) {
      playbackCache.clear();
      preloader.clear(true);
      directAdapter?.clearMediaInfoCache();
    }
    const sdkChanged = playbackSDK.provider !== result.playbackSdk.provider;
    playbackSDK = result.playbackSdk;
    // 轻量适配器定义随 Runtime 就绪，配置返回后不再等待另一业务模块；Full SDK/CSS 仍由可信通道的 getConstructor 懒加载。
    // 同一公开配置复用构造器和许可初始化；Visitor 刷新不重新下载 SDK。
    if (playbackSDK.provider === "byteplus_web" && (!directAdapter || sdkChanged)) {
      directAdapter = new DirectVePlayerAdapter();
    }
    api.configurePlayback(result);
    playbackCovers.clear();
    logClientEvent("info", "player_configuration_ready", {
      tiktokAppId: applicationProfile.tiktokAppId, provider: playbackSDK.provider,
    });
    appConfig = result;
    applicationBrand = { name: result.appName, logoUrl: result.logoUrl };
    complianceBaseURL = result.complianceBaseUrl;
    interstitialAdUnitId = result.interstitialAdUnitId?.trim() || "";
    document.title = applicationBrand.name;
    if (visitorID) eventReporter.identify(currentOpenID, applicationProfile.clientKey, applicationBrand.name);
    setAdExperience({ ...adExperience, monetizationPolicy: result.monetization });
  };

  /** loadAppConfig 合并配置读取并复用本次前台确认；显式恢复强制刷新，失败后允许重试且不重新换码。 */
  const loadAppConfig = async (forceRefresh = false): Promise<void> => {
    if (!configLoading) {
      if (configConfirmed && appConfig && !forceRefresh) return;
      configConfirmed = false;
      const owner = configGeneration;
      // 一次性交接只用于普通启动；显式恢复始终重新向服务端确认配置。
      const response = !forceRefresh && configGeneration === 0 && initialConfigResponse
        ? initialConfigResponse : api.appConfig(applicationProfile.tiktokAppId);
      initialConfigResponse = undefined;
      const pending = response.then(async result => {
        await applyAppConfig(result);
        configConfirmed = owner === configGeneration;
      }).catch(reason => {
        logClientEvent("error", "app_configuration_failed", { error: safeErrorMessage(reason instanceof Error && reason.cause !== undefined ? reason.cause : reason) });
        throw reason;
      }).finally(() => { if (configLoading === pending) configLoading = undefined; });
      configLoading = pending;
    }
    await configLoading;
    // 跨前后台的迟到响应不能确认新前台；前台调用方共用一次新读取，后台不主动补发。
    if (!configConfirmed && getVisibilitySnapshot().visible) await loadAppConfig();
  };

  /** applySession 仅安装身份与用户分区，不等待应用配置或任何个人查询。 */
  const applySession = (result: SessionResult): void => {
    if (result.tiktokAppId !== applicationProfile.tiktokAppId || (appConfig && appConfig.applicationId !== result.applicationId)) {
      throw new ApiError("Session does not match application", 200, "invalid_response");
    }
    saveVisitorToken(applicationProfile.tiktokAppId, result.visitorToken);
    if (applicationID !== result.applicationId || visitorID !== result.visitorId) {
      // 待领取奖励按服务端确认的用户隔离，不能在切换 TikTok 账号后转移给新用户。
      pendingClaims = new PendingClaimStore(storage, `${applicationProfile.tiktokAppId}:${result.applicationId}:${result.visitorId}`);
      pendingAdShows = new PendingAdShowStore(storage, `${applicationProfile.tiktokAppId}:${result.applicationId}:${result.visitorId}`, () => api.serverNow());
      // 旧播放页持有旧 Store 的引用，卸载补写仍只落到原 Visitor。
      localLibrary = new LocalLibraryStore(applicationProfile.tiktokAppId, result.visitorId, storage);
      playbackCache.clear();
      playbackCovers.clear();
      preloader?.clear(true);
      directAdapter?.clearMediaInfoCache();
      identityGeneration += 1;
      vipRefreshAbort?.abort();
      vipRefresh = undefined;
      vipRefreshAbort = undefined;
      entryConfirmations.clear();
      adExperience = { ...EMPTY_AD_EXPERIENCE, monetizationPolicy: appConfig?.monetization ?? EMPTY_AD_EXPERIENCE.monetizationPolicy, refreshRequired: true };
      vipConfirmationOrder = 0;
    }
    applicationID = result.applicationId;
    visitorID = result.visitorId;
    currentOpenID = result.tiktokOpenId ?? "";
    sessionCampaign = result.campaign;
    eventReporter.identify(currentOpenID, applicationProfile.clientKey, applicationBrand.name);
  };

  const applyVIPState = (
    vipState: VIPState | undefined,
  ) => {
    // 调用方已校验结算主体；进度与生效状态直接采用服务端事实，不在客户端模拟计划版本。
    const next = vipState ?? adExperience.vipState;
    if (next === adExperience.vipState) return;
    vipConfirmationOrder = api.requestSequence;
    setAdExperience({
      ...adExperience,
      vipState: next,
    });
  };

  // 所有播放查询（含预取）共用运行时状态入口，页面不能持有与服务端相反的 VIP 状态。
  const resolvePlay = api.resolvePlay.bind(api);
  api.resolvePlay = async (dramaId, episodeId) => {
    const owner = captureClaimOwner();
    const revision = vipStateRevision;
    const result = await resolvePlay(dramaId, episodeId);
    if (isCurrentOwner(owner) && revision === vipStateRevision && "vipState" in result) applyVIPState(result.vipState);
    return result;
  };

  // 预取只接收当前前台合法来源，SDK 实现和缓存均留在独立播放器适配器内。
  const prefetchPlaybackInfo = (source: PlaybackSource, stage: "launch" | "next_episode"): void => {
    if (playbackSDK.provider === "byteplus_web" && sessionState === "ready" && sessionSubjectKey &&
        getVisibilitySnapshot().visible && !fullscreenAds.isBusy() && !isFullscreenAdBlockingPlayback(window.TTMinis)) {
      directAdapter?.prefetchMediaInfo(source, stage);
    }
  };

  const requestPlaybackEntry = async (input: PlaybackEntryInput, configurationReady?: Promise<void>) => {
    const subject = sessionSubjectKey;
    const owner = captureClaimOwner();
    const epoch = getVisibilitySnapshot().epoch;
    const revision = entitlementRevision;
    const result = await api.playbackEntry(input, configurationReady);
    if (!isCurrentOwner(owner) || !subject || sessionSubjectKey !== subject) throw identityChangedError();
    if (!result) return undefined;
    // 前后台变化或奖励结算撤销旧快照，落地目标仍可导航，剧场重新读取最新决策。
    if (getVisibilitySnapshot().epoch !== epoch || entitlementRevision !== revision) return { target: result.target };
    if (result.vipState.responseOrder === undefined || result.vipState.responseOrder > vipConfirmationOrder) applyVIPState(result.vipState);
    const { dramaId, episodeId } = result.target;
    if (result.play) playbackCache.seed(subject, dramaId, episodeId, result.play);
    else playbackCache.forget(subject, dramaId, episodeId);
    const coverKey = JSON.stringify([subject, identityGeneration, dramaId, episodeId]);
    const cover = result.episode.posterUrl?.trim() || result.drama.coverUrl.trim();
    // 已确认的投放目标可直接准备一张海报，避免额外读取目录或等待路由绘制。
    if (input.source === "launch") {
      if (cover && getVisibilitySnapshot().visible) coverLoader.request(cover, "high", true);
      // 投放正片授权可以与进剧场交接并行，锁定和试看响应不进入该缓存。
      if (result.play?.status === "playable") prefetchPlaybackInfo(result.play.playback, "launch");
    }
    if (playbackCovers.size >= 32) playbackCovers.delete(playbackCovers.keys().next().value!);
    playbackCovers.set(coverKey, { promise: Promise.resolve(cover), url: cover, expiresAt: performance.now() + timePolicy.playbackCacheMs });
    return { target: result.target, snapshot: { entry: result, subject, epoch, revision, at: performance.now() } };
  };

  api.setSessionInputProvider(bootstrapInput, applySession);
  api.setSessionStateObserver((usable) => {
    if (usable) sessionSubjectKey = JSON.stringify([applicationID, visitorID]);
    setSessionState(usable ? "ready" : "recovery_required");
    adErrors.identify(usable ? sessionSubjectKey : "");
    // HttpMiniDramaApi 完成凭据安装后才公开新主体，重挂页面的请求才能绑定正确身份。
    // 身份安装失败封闭会话；应用配置或广告入口故障不经过这条身份通知路径。
    if (usable) {
      if (!metricVisibilityInstalled) {
        let previousVisibility = getVisibilitySnapshot();
        observeVisibility(window.TTMinis, (visible) => {
          const visibility = getVisibilitySnapshot();
          // 只豁免网页状态未变且仅跨一个版本的首次宿主前台确认；同步 hide→show 的版本缺口仍须撤销许可。
          const firstNativeForeground = previousVisibility.nativeVisibility === "unknown" && visibility.nativeVisibility === "visible" &&
            previousVisibility.visible && visibility.visible && visibility.epoch === previousVisibility.epoch + 1 &&
            visibility.documentVisibility === previousVisibility.documentVisibility && visibility.prerendering === previousVisibility.prerendering;
          // 先保存证据，避免订阅副作用同步触发新生命周期后，又被本次旧回调覆盖。
          previousVisibility = visibility;
          metrics.setVisible(visible);
          if (firstNativeForeground) return;
          // 后台发起或返回的响应同样不能直接用于回前台的新决定。
          api.invalidateTime();
          playbackCache.clear(false);
          directAdapter?.clearMediaInfoCache();
          if (!visible) {
            // WebView 后台的单调时钟可能停走；旧许可和在途响应都不能直接用于回前台的新决定。
            window.clearTimeout(vipExpiryTimer);
            vipRefreshAbort?.abort();
            vipRefreshAbort = undefined;
            vipRefresh = undefined;
          } else if (sessionState === "ready" && adExperience.monetizationPolicy.vip.enabled) {
            const owner = captureClaimOwner();
            setAdExperience({ ...adExperience, refreshRequired: true, refreshError: undefined });
            publishEntitlement({ rewardType: "vip_progress" }, owner, "vip_recheck");
            void refreshAdExperience().catch(() => { /* 刷新入口已经记录错误。 */ });
          }
        });
        metricVisibilityInstalled = true;
      }
      metrics.identify(sessionSubjectKey);
      // 401 恢复后重新确认新主体状态，身份安装本身不等待此读取。
      if (initialized && adExperience.refreshRequired) void refreshAdExperience().catch(() => { /* 查询边界已记录错误。 */ });
      publishAdExperience();
      // 每次身份安装后检查当前分区，覆盖迟到完播发生在 B、随后 A 重新登录的情况。
      recoveryDelay = 5_000;
      scheduleClaimRecovery();
    }
  });

  const recoverPendingClaims = async (): Promise<ClaimResult[]> => {
    if (recoveryRunning || sessionState !== "ready") return [];
    recoveryRunning = true;
    const owner = captureClaimOwner();
    try {
      const retriedClaims = await retryPendingClaims(
        { claimReward: input => {
          const original = claimOwners.get(input.claimId);
          // 仅队列恢复可重新绑定当前页面代际；原始应用与账号必须相同，旧页面直接调用仍受代际门禁保护。
          return claimRewardForOwner(input, original && !isSameSubject(original, owner) ? original : owner);
        } },
        owner.store,
        isRetryableClaimError,
        (error) => isCurrentOwner(owner) && !(error instanceof ApiError && error.code === "identity_changed"),
      );
      if (!isCurrentOwner(owner)) return [];
      recoveryDelay =
        retriedClaims.length > 0 ? 5_000 : Math.min(60_000, recoveryDelay * 2);
      return isCurrentOwner(owner) ? retriedClaims : [];
    } finally {
      recoveryRunning = false;
    }
  };

  const scheduleClaimRecovery = () => {
    if (sessionState !== "ready" || pendingClaims.list().length === 0 || recoveryTimer !== undefined)
      return;
    recoveryTimer = window.setTimeout(async () => {
      recoveryTimer = undefined;
      try { await recoverPendingClaims(); }
      catch (reason) { logClientEvent("error", "pending_claim_recovery_failed", { error: safeErrorMessage(reason) }); }
      finally { scheduleClaimRecovery(); }
    }, recoveryDelay);
  };

  const installClaimRecovery = () => {
    if (recoveryInstalled) return;
    recoveryInstalled = true;
    window.addEventListener("online", () => {
      recoveryDelay = 5_000;
      void recoverPendingClaims().finally(scheduleClaimRecovery);
    });
  };

  const showAd = async (adUnitId: string, claim?: RewardClaim, onShown?: () => void, intent = captureAdIntent()): Promise<RewardedAdResult> => {
    if (sessionState !== "ready") throw new ApiError("Viewer state could not be restored", 503, "identity_unavailable");
    if (pendingClaims.list().length > 0) {
      // 已看完但未确认的广告必须先补领，不能通过新广告生成第二个 ClaimID。
      throw new ApiError("Reward confirmation is pending", 503, "reward_pending_confirmation");
    }
    if (!claim || claim.adUnitId !== adUnitId || activeAdClaims.has(claim.claimId)) {
      // 所有内部入口必须先生成 ClaimID，避免广告完成后无法知道奖励原本属于谁。
      throw new ApiError("Reward claim context is required", 400, "reward_context_invalid");
    }
    const owner = claimOwners.get(claim.claimId) ?? captureClaimOwner();
    assertClaimOwner(owner);
    claimOwners.set(claim.claimId, owner);
    const completedClaim = { ...claim };
    const adID = createMetricID();
    const adScene = claim.episodeId ? "episode_unlock" : claim.dramaId ? "entry_reward" : "vip_reward";
    const observeAd = adMetrics("rewarded", adUnitId, adScene, adID);
    const releaseAd = fullscreenAds.acquire(false);
    if (!releaseAd) {
      const message = "Another full-screen ad is still active";
      observeAd({ kind: "ad_trigger", stage: "gate" });
      observeAd({ kind: "ad_skipped", stage: "gate", reason: "busy" });
      logClientEvent("warn", "rewarded_ad_busy", { error: message });
      return { status: "failed", message };
    }
    activeAdClaims.add(claim.claimId);
    let result: RewardedAdResult;
    try {
      // 剧目资料与广告展示并行；仅官方事件回传等待目录，查询失败不改变广告与领奖结果。
      let contextRequest: Promise<DramaDetail | undefined> | undefined;
      if (claim.dramaId && !eventReporter.hasDrama(claim.dramaId)) {
        contextRequest = api.drama(claim.dramaId).catch(reason => {
          logClientEvent("warn", "ad_drama_context_failed", { error: safeErrorMessage(reason) });
          return undefined;
        });
      }
      assertClaimOwner(owner);
      const officialShown = eventReporter.captureRewardedAd(claim.dramaId, "RewardedVideoAd", adScene, contextRequest);
      const metricShown = metrics.capture("rewarded_show", adID);
      const metricCompleted = metrics.capture("rewarded_complete", adID);
      result = await showRewardedAd(window.TTMinis, adUnitId, () => { officialShown(); metricShown(); onShown?.(); }, () => {
        // 本地等待超时不抹掉原生完播事实；始终写入发起广告时的主体分区和原 ClaimID。
        owner.store.add(completedClaim);
        metricCompleted();
        logClientEvent("info", "rewarded_ad_late_completion_preserved");
        if (isSameSubject(owner, captureClaimOwner())) {
          recoveryDelay = 5_000;
          scheduleClaimRecovery();
        }
      }, observeAd, { ...intent, isCurrent: () => sessionState === "ready" && isCurrentOwner(owner) && intent.isCurrent() });
      if (result.status === "completed") metricCompleted();
    } finally {
      releaseAd();
      activeAdClaims.delete(completedClaim.claimId);
    }
    if (result.status !== "completed") {
      return result;
    }
    // 官方明确完整播放后立即保存到广告发起时的分区；即使此时已经换号也不丢失。
    owner.store.add(completedClaim);
    assertClaimOwner(owner);
    return result;
  };

  const sendAdShow = async (owner: ClaimOwner, show: AdShow): Promise<AdShowConfirmation> => {
    // 先保存到原主体分区；账号切换时停止发送，切回后仍能补报同一事实。
    owner.showStore.add(show);
    try {
      assertClaimOwner(owner);
      const confirmed = await api.recordAdShow(show);
      owner.showStore.remove(show.eventId);
      assertClaimOwner(owner);
      if (confirmed.entryAdStatus?.countBy === "shown") {
        const state = confirmed.entryAdStatus;
        const key = state.scope === "user" ? "*" : show.dramaId ?? "";
        const previous = entryConfirmations.get(key);
        if (!previous?.responseOrder || !state.responseOrder || state.responseOrder >= previous.responseOrder) {
          entryConfirmations.set(key, state);
          publishEntitlement({ rewardType: "entry_progress", dramaId: show.dramaId, entryAdStatus: state }, owner);
        }
      }
      return confirmed;
    } catch (reason) {
      if (isCurrentOwner(owner) && !isRetryableClaimError(reason)) owner.showStore.remove(show.eventId);
      logClientEvent("warn", "ad_show_confirmation_failed", { error: safeErrorMessage(reason) });
      throw reason;
    }
  };

  const retryPendingAdShows = async (scene?: string): Promise<number> => {
    const owner = captureClaimOwner();
    let confirmed = 0;
    for (const show of owner.showStore.list()) {
      if (scene && scene !== show.scene) continue;
      assertClaimOwner(owner);
      await sendAdShow(owner, show);
      confirmed++;
    }
    return confirmed;
  };

  const showEntryAd = async (claim: RewardClaim, requireShowConfirmation = true, intent?: AdIntent): Promise<RewardedAdResult & { entryAdStatus?: EntryAdStatus }> => {
    const owner = claimOwners.get(claim.claimId) ?? captureClaimOwner();
    if (!claim.dramaId || claim.episodeId) throw new ApiError("Entry ad drama context is required", 400, "reward_context_invalid");
    let confirmation: Promise<{ accepted: true; state?: EntryAdStatus } | { accepted: false; reason: unknown }> | undefined;
    const result = await showAd(claim.adUnitId, claim, () => {
      const show: AdShow = { eventId: claim.claimId, scene: "entry_reward",
        dramaId: claim.dramaId!, adUnitId: claim.adUnitId };
      // 网络请求与广告并行，先接住拒绝，广告退出后再把故障交给门禁处理。
      confirmation = sendAdShow(owner, show).then(value => ({ accepted: true as const, state: value.entryAdStatus }), reason => ({ accepted: false as const, reason }));
    }, intent);
    if (requireShowConfirmation && confirmation) {
      const confirmed = await confirmation;
      if (!confirmed.accepted) throw confirmed.reason;
      assertClaimOwner(owner);
      return confirmed.state ? { ...result, entryAdStatus: confirmed.state } : result;
    }
    assertClaimOwner(owner);
    return result;
  };

  const claimKey = (input: RewardClaim, owner: ClaimOwner): string => JSON.stringify([owner.applicationID, owner.visitorID, input.claimId]);
  const settleClaim = async (claimInput: RewardClaim, owner: ClaimOwner): Promise<ClaimResult> => {
    // 领取上下文可由当前账号队列恢复，但原始归属不能覆盖，防止旧页面把 ClaimID 搬到其他账号。
    if (!claimOwners.has(claimInput.claimId)) claimOwners.set(claimInput.claimId, owner);
    let queued = false;
    let settlementConfirmed = false;
    try {
      assertClaimOwner(owner);
      // 旧页面的迟到调用不得把已结算记录重新放回队列；主体通过校验后才登记待确认。
      owner.store.add(claimInput);
      queued = true;
      // 切号或跨日后的补领仍使用原 ClaimID 请求幂等结算，让服务端返回当前状态，不能复用旧快照。
      const claim = await api.claimReward(claimInput);
      settlementConfirmed = true;
      assertClaimOwner(owner);
      owner.store.remove(claimInput.claimId);
      applyVIPState(claim.vipState);
      publishEntitlement(claim, owner);
      return claim;
    } catch (error) {
      if (!queued) {
        logClientEvent("warn", "reward_claim_not_started", { error: safeErrorMessage(error) });
        throw error;
      }
      if (settlementConfirmed) {
        // 已有结算事实时只报告页面上下文更新失败，不能虚报“已保存待领取”。
        logClientEvent("warn", "reward_claim_context_not_applied", {
          error: safeErrorMessage(error),
          flow: "reward_claim", stage: "post_settlement", outcome: "settlement_confirmed",
          errorType: error instanceof ApiError ? error.code : "unknown_error",
        });
        throw error;
      }
      if (!isRetryableClaimError(error)) {
        owner.store.remove(claimInput.claimId);
        logClientEvent("warn", "reward_claim_rejected", { error: safeErrorMessage(error) });
        throw error;
      }
      logClientEvent("warn", "reward_claim_preserved", {
        error: safeErrorMessage(error),
        flow: "reward_claim", stage: "settlement", outcome: "pending_confirmation",
        errorType: error instanceof ApiError ? error.code : "unknown_error",
      });
      recoveryDelay = 5_000;
      scheduleClaimRecovery();
      throw error;
    }
  };

  const settlingClaims = new Map<string, Promise<ClaimResult>>();
  // 前台点击与后台补领共用同一请求和权益通知；完成或失败后才允许原 ClaimID 重试。
  const claimRewardForOwner = (claimInput: RewardClaim, owner: ClaimOwner): Promise<ClaimResult> => {
    if (!isCurrentOwner(owner)) return settleClaim(claimInput, owner);
    // 同一主体切回 A 后也必须加入已有在途领取，不能因页面代际变化并发请求同一 ClaimID。
    const key = claimKey(claimInput, owner);
    const existing = settlingClaims.get(key);
    if (existing) return existing;
    const request = settleClaim(claimInput, owner);
    settlingClaims.set(key, request);
    const clear = () => { if (settlingClaims.get(key) === request) settlingClaims.delete(key); };
    void request.then(clear, clear);
    return request;
  };
  const claimReward = (claimInput: RewardClaim): Promise<ClaimResult> =>
    claimRewardForOwner(claimInput, claimOwners.get(claimInput.claimId) ?? captureClaimOwner());

  /** assertVIPAdState 区分正常权益重查与真实故障，防止入剧广告回前台时中断后续 VIP 自动衔接。 */
  const assertVIPAdState = (): void => {
    if (!adExperience.refreshRequired) return;
    if (!adExperience.refreshError) {
      throw new ApiError("VIP state refresh is in progress", 503, "vip_refresh_pending");
    }
    throw new ApiError("VIP state requires confirmation", 503, "invalid_response");
  };

  const watchVIPAd = async (
    offer?: AccessOffer,
    intent = captureAdIntent(),
  ): Promise<ClaimResult | null> => {
    expireVIP();
    assertVIPAdState();
    const { monetizationPolicy, vipState } = adExperience;
    const hasVIPOffer =
      offer?.kind === "rewarded_vip";
    if (
      (!hasVIPOffer &&
        (monetizationPolicy.status !== "enabled" ||
          !monetizationPolicy.vip.enabled)) ||
      (offer && !hasVIPOffer)
    ) {
      throw new ApiError("Daily VIP policy is unavailable", 503, "vip_offer_unavailable");
    }
    if (vipState.active) return null;

    const owner = captureClaimOwner();
    // 显式播放决策提供的入口可复用；首页/VIP 门禁按需读取，不在启动或恢复时预先请求。
    const currentOffer = offer ?? await api.vipOffer();
    assertClaimOwner(owner);
    // 入口查询期间可能领取成功或进入后台，迟到入口不能再拉起一条广告。
    expireVIP();
    if (adExperience.vipState.active) return null;
    assertVIPAdState();
    if (!currentOffer) throw new ApiError("Daily VIP offer is unavailable", 503, "vip_offer_unavailable");
    const claimInput = createRewardClaim(currentOffer);
    const result = await executeVIPRewardedAd(
      claimInput,
      (adUnitId) => showAd(adUnitId, claimInput, undefined, { ...intent, isCurrent: () => !adExperience.vipState.active && !adExperience.refreshRequired && intent.isCurrent() }),
      claimReward,
    );
    if (result.status === "completed") return result.claim;
    if (result.status === "cancelled") return null;
    if (result.status === "unknown") {
      throw new ApiError("Native ad result is still pending", 503, "rewarded_ad_pending");
    }
    // 广告没有拉起与完播后待确认必须区分；原始原因只进入日志，不直接显示给用户。
    if (result.status === "unavailable") {
      if (result.reason === "client_outdated") throw new ApiError(result.message ?? "TikTok client does not support rewarded ads", 503, "rewarded_ad_client_outdated");
      throw new ApiError(result.message ?? "VIP rewarded ad could not start", 503, result.reason === "container_unavailable" || result.reason === "container_suspended" || result.reason === "not_visible" || result.reason === "stale_intent" ? "ad_foreground_required" : "rewarded_ad_unavailable");
    }
    if (result.status === "pending") {
      throw new ApiError("Reward confirmation is pending", 503, "reward_pending_confirmation");
    }
    throw new Error(text("runtime.vipRewardError"));
  };

  const claimVIP = async (): Promise<VIPState> => {
    const owner = captureClaimOwner();
    try {
      const state = await api.claimVIP();
      assertClaimOwner(owner);
      const newlyActive = !adExperience.vipState.active && state.active;
      applyVIPState(state);
      // VIP 领取可能已经解锁当前首集，门禁放行前通知剧场重新验权。
      if (newlyActive) publishEntitlement({ rewardType: "vip_progress" }, owner);
      return state;
    } catch (error) {
      logClientEvent(error instanceof ApiError && error.code === "identity_changed" ? "warn" : "error", "vip_manual_claim_failed", { error: safeErrorMessage(error) });
      throw error;
    }
  };

  const initializeSession = (forceIdentity = false): Promise<void> => {
    if (sessionInitialization) return sessionInitialization;
    const pending = (async () => {
      logClientEvent("info", "bootstrap_started", { flow: "bootstrap", stage: "initialize", outcome: "started" });
      try {
        // 配置和认证彼此独立；配置/落地失败后的重试保留已成功安装的登录态。
        identityInitialization = api.hasSession && !forceIdentity
          ? Promise.resolve()
          : bootstrapInput().then(input => api.createSession(input)).then(() => undefined);
        let configurationFailed = false;
        const configurationReady = loadAppConfig(forceIdentity).catch(reason => {
          configurationFailed = true;
          throw reason;
        });
        const launchPending = identityInitialization.then(() => {
          // 配置已失败时，迟到的会话留给用户重试，已结束的启动不再发出投放请求。
          if (configurationFailed) return;
          const launchQuery = readLaunchQuery(window.location.search);
          const hash = window.location.hash;
          const rootLaunch = !hash || hash === "#" || hash === "#/";
          const hasTarget = rootLaunch && Boolean(sessionCampaign?.dramaId || ["dramaId", "drama_id", "albumId", "album_id"].some(key => launchQuery[key]));
          // 会话安装后立刻请求投放，通道确认后才允许安装封面和本次广告、VIP 与播放决策。
          if (hasTarget) return requestPlaybackEntry({ source: "launch", launchQuery }, configurationReady);
        });
        const [, launch] = await Promise.all([configurationReady, launchPending]);
        launchTarget = launch?.target;
        launchEntry = launch?.snapshot;
        if (!launchTarget) void refreshAdExperience().catch(() => { /* 刷新边界记录原始故障及恢复入口。 */ });
        initialized = true;
        setSessionState("ready");
        installClaimRecovery();
        // 旧广告结算不属于本次启动，后台恢复仍保留原主体和 ClaimID。
        void recoverPendingClaims().catch(reason => {
          logClientEvent("error", "pending_claim_recovery_failed", { error: safeErrorMessage(reason) });
        }).finally(scheduleClaimRecovery);
        // 展示补报与奖励恢复独立，不能使完整观看模式或启动依赖展示表。
        void retryPendingAdShows().catch(reason => {
          logClientEvent("warn", "pending_ad_show_recovery_failed", { error: safeErrorMessage(reason) });
        });
        logClientEvent("info", "bootstrap_succeeded", { flow: "bootstrap", stage: "complete", outcome: "success" });
      } catch (reason) {
        logClientEvent("error", "bootstrap_failed", {
          flow: "bootstrap", stage: "complete", outcome: "failed",
          error: safeErrorMessage(reason),
          errorType: reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.name : typeof reason,
        });
        throw reason;
      }
    })();
    sessionInitialization = pending;
    const clear = () => {
      if (sessionInitialization === pending) {
        sessionInitialization = undefined;
        identityInitialization = undefined;
        initialPlatformReady = undefined;
        initialLogin = undefined;
      }
    };
    void pending.then(clear, clear);
    return pending;
  };

  return {
    resolvePlaybackEntry: async (dramaId, episodeId) => {
      const pending = launchEntry;
      launchEntry = undefined;
      if (pending?.entry.target.dramaId === dramaId && pending.entry.target.episodeId === episodeId &&
          pending.subject === sessionSubjectKey && pending.epoch === getVisibilitySnapshot().epoch &&
          pending.revision === entitlementRevision && performance.now() - pending.at < timePolicy.playbackCacheMs) return pending.entry;
      const result = await requestPlaybackEntry({ source: "selection", dramaId, episodeId });
      if (!result?.snapshot) throw new ApiError("Playback entry is no longer current", 503, "invalid_response");
      return result.snapshot.entry;
    },
    getCachedPlayable: (dramaId, episodeId) => {
      expireVIP();
      if (sessionState !== "ready" || !sessionSubjectKey || !getVisibilitySnapshot().visible) return undefined;
      return playbackCache.getPlayable(sessionSubjectKey, dramaId, episodeId);
    },
    resolvePlayback: (dramaId, episodeId) => {
      expireVIP();
      if (sessionState !== "ready" || !sessionSubjectKey) return Promise.reject(identityChangedError());
      return playbackCache.resolve(sessionSubjectKey, dramaId, episodeId, () => api.resolvePlay(dramaId, episodeId));
    },
    resolvePlaybackBatch: (dramaId, episodeIds) => {
      expireVIP();
      if (sessionState !== "ready" || !sessionSubjectKey) return Promise.reject(identityChangedError());
      return api.resolvePlayBatch(dramaId, episodeIds);
    },
    invalidatePlayback: () => {
      playbackCache.clear(false);
      directAdapter?.clearMediaInfoCache();
    },
    prefetchPlaybackInfo: (source) => prefetchPlaybackInfo(source, "next_episode"),
    canPreloadMedia: () => playbackSDK.provider === "tiktok_minis",
    preloadMedia: async (sources, scene) => {
      // 基础版独立应用不调用宿主高级媒体预加载，API 权益预取仍可共用。
      if (playbackSDK.provider === "byteplus_web") return;
      await preloader?.update(sources.map((source) => officialPlayerOptions(source)), scene);
    },
    clearMediaPreload: (purge = false) => {
      preloader?.clear(purge);
      directAdapter?.clearMediaInfoCache();
    },
    isFullscreenAdActive: () => fullscreenAds.isBusy() || isFullscreenAdBlockingPlayback(window.TTMinis),
    async showInterstitialIfEligible(eligible, scene = "home_interstitial") {
      try {
      // 插屏资格检查仍显式复核策略，避免长期停留首页时沿用已停用的广告位。
      await loadAppConfig(true);
      expireVIP();
      if (sessionState !== "ready" || adExperience.refreshRequired || !interstitialAdUnitId || !window.TTMinis?.createInterstitialAd || (window.TTMinis.canIUse && !window.TTMinis.canIUse("createInterstitialAd")) || adExperience.monetizationPolicy.status !== "enabled" || !getVisibilitySnapshot().visible || adExperience.vipState.active || !eligible()) return;
      const release = fullscreenAds.acquire(true, window.TTMinis);
      if (!release) return;
      try {
        const officialShown = eventReporter.captureRewardedAd(undefined, "InterstitialAd", scene);
        const metricShown = metrics.capture("interstitial_show");
        await showInterstitial(window.TTMinis, interstitialAdUnitId, () => { officialShown(); metricShown(); }, adMetrics("interstitial", interstitialAdUnitId, scene), captureAdIntent(() => sessionState === "ready" && !adExperience.refreshRequired && !adExperience.vipState.active && eligible()));
      }
      finally { release(); }
      } catch (error) { logClientEvent("warn", "interstitial_eligibility_failed", { error: safeErrorMessage(error) }); }
    },
    getSessionState: () => sessionState,
    getSessionSubjectKey: () => sessionSubjectKey,
    subscribeSessionState(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    recoverSession: () => initializeSession(true),
    subscribeEntitlements(listener) {
      entitlementListeners.add(listener);
      return () => entitlementListeners.delete(listener);
    },
    getEntitlementRevision: () => entitlementRevision,
    getApplicationID: () => applicationID,
    reportPlaybackEvent: (event, drama, episodeId) => {
      eventReporter.playback(event, drama, episodeId);
      metrics.playbackEvent(event === "video_play_request" ? "request" : "start", `${drama.id}:${episodeId}`);
    },
    reportPlaybackComplete: (dramaId, episodeId) => metrics.playbackEvent("complete", `${dramaId}:${episodeId}`),
    reportPlaybackQuality: (kind) => metrics.recordQuality(kind),
    clearPlaybackEventContext: () => { eventReporter.clearPlaybackContext(); metrics.clearPlayback(); },
    api,
    get localLibrary() { return localLibrary; },
    bootstrap: () => initializeSession(),
    prefetchAppConfig: () => loadAppConfig(),
    whenPlatformReady: async () => { await platformReadyForStartup(); void readSystemInfo(); },
    getCachedHomeSections: publicHome.sections.snapshot,
    getCachedHomeCarousel: publicHome.carousel.snapshot,
    getCachedHomeHot: publicHome.hot.snapshot,
    getCachedHomeRankingCategories: publicRankings.categories.snapshot,
    getCachedHomeRankingPage: publicRankings.snapshot,
    getCachedPublicCatalog: publicHome.catalog.snapshot,
    loadReviewHome: api.reviewHome ? () => api.reviewHome!(applicationProfile.tiktokAppId) : undefined,
    async prefetchHome(onSections) {
      let latest: import("../domain/types").HomeSections = publicHome.sections.snapshot() || { carousel: [], hot: [], rankings: [] };
      const publish = (change: Partial<import("../domain/types").HomeSections>) => {
        latest = { ...latest, ...change };
        onSections?.(latest);
      };
      await Promise.all([
        publicHome.carousel.load().then(value => publish({ carousel: value })),
        publicHome.hot.load().then(value => publish({ hot: value })),
        publicRankings.categories.load(),
        publicHome.catalog.load(),
      ]);
    },
    loadHomeSections: publicHome.sections.load,
    loadHomeCarousel: publicHome.carousel.load,
    loadHomeHot: publicHome.hot.load,
    loadHomeRankingCategories: publicRankings.categories.load,
    loadHomeRankingPage: publicRankings.load,
    loadPublicCatalog: async (input) => {
      if(!input?.cursor&&!input?.query&&!input?.tag&&!input?.status&&(input?.limit??20)===20) return publicHome.catalog.load();
      return api.publicCatalog(applicationProfile.tiktokAppId,input);
    },
    getCachedPlaybackCover(dramaId, episodeId) {
      // 只交接已经确认的展示图片，未知身份、分集或过期缓存均不触发网络或播放放行。
      if (sessionState !== "ready" || !sessionSubjectKey || !dramaId || !episodeId) return "";
      const key = JSON.stringify([sessionSubjectKey, identityGeneration, dramaId, episodeId]);
      const existing = playbackCovers.get(key);
      if (!existing) return "";
      if (existing.expiresAt <= performance.now()) {
        playbackCovers.delete(key);
        return "";
      }
      return existing.url || "";
    },
    loadPlaybackCover(dramaId, episodeId) {
      if (sessionState !== "ready" || !sessionSubjectKey) {
        const error = identityChangedError();
        logClientEvent("warn", "playback_launch_cover_load_failed", { error: error.message });
        return Promise.reject(error);
      }
      const now = performance.now();
      for (const [key, entry] of playbackCovers) if (entry.expiresAt <= now) playbackCovers.delete(key);
      const subject = sessionSubjectKey;
      const generation = identityGeneration;
      const key = JSON.stringify([subject, generation, dramaId, episodeId]);
      const existing = playbackCovers.get(key);
      if (existing) return existing.promise;
      const pending = api.drama(dramaId).then(detail => {
        // A→B→A 后旧请求即使主体字符串再次相同，也不能填入新访问的封面。
        if (subject !== sessionSubjectKey || generation !== identityGeneration) throw identityChangedError();
        if (detail.id !== dramaId) throw new Error("Playback preview drama does not match requested target");
        const url = detail.episodes.find(episode => episode.id === episodeId && episode.dramaId === dramaId)?.posterUrl?.trim() || detail.coverUrl.trim();
        const current = playbackCovers.get(key);
        // 配置刷新会清除旧缓存；只有仍归属本次在途任务的记录才能交接同步图片。
        if (current?.promise === pending) current.url = url;
        return url;
      }).catch(reason => {
        if (playbackCovers.get(key)?.promise === pending) playbackCovers.delete(key);
        logClientEvent("warn", "playback_launch_cover_load_failed", { error: safeErrorMessage(reason instanceof Error && reason.cause !== undefined ? reason.cause : reason) });
        throw reason;
      });
      if (playbackCovers.size >= 32) playbackCovers.delete(playbackCovers.keys().next().value!);
      playbackCovers.set(key, { promise: pending, expiresAt: now + timePolicy.playbackCacheMs });
      return pending;
    },
    async refreshBootstrap() {
      await initializeSession(true);
    },
    async preparePlayback() {
      const identityReady = identityInitialization;
      let platformFailure: { reason: unknown } | undefined;
      // 即刻订阅同一次官方初始化；失败由 SDK 边界记录，配置迟到不能自动发起第二次初始化。
      const platformReady = platformReadyForStartup().catch(reason => {
        platformFailure = { reason };
        throw reason;
      });
      const preparation = (async () => {
        // 先确认公开配置，共用启动请求，不能按占位通道或包内身份猜测。
        await loadAppConfig();
        if (platformFailure) throw platformFailure.reason;
        // 独立适配器先加载包内资源，内部仍等待 SDK 初始化和页面校验后才配置许可。
        // 官方通道只等待平台与身份安装，构造器准备和可信落地解析并行，不额外换码。
        if (playbackSDK.provider === "tiktok_minis") {
          await platformReady;
          if (identityReady) await identityReady;
        }
        if (!appConfig) throw new Error(text("runtime.playerUnavailable"));
        if (playbackSDK.provider === "byteplus_web") {
          if (!directAdapter) throw new Error(text("runtime.playerUnavailable"));
          await directAdapter.getConstructor(platformReady);
          return;
        }
        if (sessionState !== "ready" || !sessionSubjectKey) throw new Error(text("runtime.playerUnavailable"));
        const ctor = await playerAdapter.getConstructor();
        await preloader?.prepare(ctor);
      })();
      // 两条分支立即接住拒绝；任何一侧失败都不交付构造器，也不产生未处理拒绝。
      await Promise.all([platformReady, preparation]);
    },
    createPlaybackEngine() {
      if (!appConfig) throw new Error(text("runtime.playerUnavailable"));
      if (playbackSDK.provider === "byteplus_web") {
        if (!directAdapter) throw new Error(text("runtime.playerUnavailable"));
        return directAdapter.createEngine();
      }
      return new TikTokMinisPlayerEngine(
        playerAdapter,
      );
    },
    showRewardedAd: (adUnitId, claim, intent) => showAd(adUnitId, claim, undefined, intent),
    showEntryAd,
    getConfirmedEntryAdStatus(dramaId) {
      const state = entryConfirmations.get(dramaId) ?? entryConfirmations.get("*");
      return state && (!state.enabled || (remainingServerTime(state) ?? 0) > 0) ? state : undefined;
    },
    retryPendingAdShows,
    registerShare(payload, onOutcome) {
      return registerTikTokShare(window.TTMinis, payload, onOutcome);
    },
    claimReward,
    claimVIP,
    retryPendingAdClaims: recoverPendingClaims,
    hasPendingAdClaim() {
      return pendingClaims.list().length > 0;
    },
    refreshAdExperience,
    getAdExperience() {
      return adExperience;
    },
    getLaunchTarget() {
      return launchTarget;
    },
    getApplicationBrand() {
      return applicationBrand;
    },
    getComplianceBaseURL() {
      return complianceBaseURL;
    },
    getVisitorID() {
      return visitorID;
    },
    subscribeAdExperience(listener: () => void) {
      experienceListeners.add(listener);
      return () => experienceListeners.delete(listener);
    },
    watchVIPAd,
  };
}
