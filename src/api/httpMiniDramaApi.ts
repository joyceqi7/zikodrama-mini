import type { AdErrorEvent } from "../observability/adErrors";
import type { MetricEvent } from "../observability/metrics";
import type { HomeRankingCategory, HomeRankingPage, HomeSections } from "../domain/types";
import type { Id } from "../domain/id";
import type {
  BootstrapResult,
  BootstrapInput,
  CampaignPlaybackPreparation,
  ClaimResult,
  DiscoveryPage,
  DiscoveryQuery,
  DramaDetail,
  HomePayload,
  MiniDramaApi,
  PlaybackEntry,
  PlaybackEntryInput,
  PlayResolveResult,
  PlaybackIdentity,
  RewardClaim,
  UnlockRecord,
  VIPState,
  SessionResult,
  AppConfig,
  AccessOffer,
  AdShowConfirmation,
} from "../domain/types";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import { ServerClock, remainingServerTime } from "../domain/serverTime";
import { timePolicy } from "../config/timePolicy";
import { foregroundTimeout } from "../platform/tiktok/foregroundTimeout";
import { miniAppVersion } from '../config/miniVersion';

interface Envelope<T> {
  /** 成功为 0，失败对应 HTTP 错误状态。 */
  code: number
  /** 稳定业务错误码，供权限与身份恢复分支使用。 */
  reason?: string
  /** 服务端安全提示文案。 */
  message: string
  /** 成功结果，失败时为 null。 */
  data?: T
  /** serverTime 是当前成功响应生成时的 UTC 基准，旧响应可能不提供。 */
  serverTime?: string
}

/** ApiError 只承载稳定的协议分类；页面必须通过 userMessage 转为友好提示。 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** status 为 HTTP 状态；0 表示尚未确认服务端响应。 */
    readonly status: number,
    /** code 区分身份、业务拒绝与可恢复故障，不能只看 HTTP 状态。 */
    readonly code?: string,
    /** requestId 用于关联服务端日志，不包含用户身份或凭据。 */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** RequestIdentity 固定请求发出时的账号与凭据代次，防止迟到响应污染新会话。 */
interface RequestIdentity {
  /** key 仅在内存中比较应用与用户，不得写入日志。 */
  key: string;
  /** generation 每次会话更新递增，旧请求不得重复触发静默恢复。 */
  generation: number;
}

/** identityChangedError 中止原账号请求，调用方保留原账号的待领取记录。 */
export function identityChangedError(): ApiError {
  return new ApiError("Viewer identity changed", 409, "identity_changed");
}

/** invalidResponse 记录合同拒绝的具体原因，不记录响应对象、Token 或授权源。 */
function invalidResponse(message: string, status = 200, requestId?: string): ApiError {
  const error = new ApiError(message, status, "invalid_response", requestId);
  logClientEvent("warn", "api_response_rejected", { error: error.message });
  return error;
}

/** HttpMiniDramaApi 将业务凭据恢复与依赖故障分开，不把普通故障当成需要登录。 */
export class HttpMiniDramaApi implements MiniDramaApi {

  /** reviewHome 独立判断版本并获取审核内容，不携带访客凭据或复用普通目录缓存。 */
  async reviewHome(tiktokAppId: string): Promise<import('../domain/types').ReviewHome> {
    const result = await this.request<import('../domain/types').ReviewHome>(`/api/v1/open/review-home?${new URLSearchParams({ tiktokAppId })}`, { cache: 'no-store' }, false);
    if (!result || result.tiktokAppId !== tiktokAppId || typeof result.enabled !== 'boolean' || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.dramas) || result.dramas.length > 100 || result.dramas.some(item => !item || typeof item.id !== 'string' || typeof item.title !== 'string')) {
      logClientEvent('error', 'review_home_response_rejected', { error: 'Review homepage response is invalid' });
      throw invalidResponse('Review homepage response is invalid');
    }
    return result;
  }
  /** visitorToken 仅作为调用自有 API 的访问凭据，不是 OpenID。 */
  private visitorToken = "";
  /** playbackProvider 只由可信启动响应安装，不能按单次播放响应切换通道。 */
  private playbackProvider: "tiktok_minis" | "byteplus_web" = "tiktok_minis";
  /** identityKey 是服务端确认的 applicationId + visitorId，仅用于内存隔离。 */
  private identityKey = "";
  /** credentialGeneration 避免并发请求使用旧凭据时反复登录。 */
  private credentialGeneration = 0;
  /** identityUsable 在观察者更新失败时封闭业务请求，防止 API 与页面处于不同账号。 */
  private identityUsable = true;
  /** bootstrapBarrier 串行化会话安装，普通请求等待身份状态完整更新。 */
  private bootstrapBarrier?: Promise<void>;
  private bootstrapInputProvider?: () => Promise<BootstrapInput>;
  private bootstrapObserver?: (result: BootstrapResult) => void | Promise<void>;
  /** sessionInputProvider 仅用于新版身份恢复，不回退聚合 bootstrap。 */
  private sessionInputProvider?: () => Promise<BootstrapInput>;
  private sessionObserver?: (result: SessionResult) => void | Promise<void>;
  /** sessionStateObserver 只通知安装成功或封闭失败，不暴露临时安装中的身份。 */
  private sessionStateObserver?: (usable: boolean) => void;
  /** visitorRefresh 保存最近一次恢复，迟到的同代请求共享其结果。 */
  private visitorRefresh?: { generation: number; promise: Promise<void> };
  private readonly fetcher: typeof fetch;
  private readonly serverClock = new ServerClock();
  private requestOrder = 0;

  constructor(
    private readonly baseUrl: string,
    fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = 15_000,
  ) {
    this.fetcher = (input, init) => fetcher(input, init);
  }

  /** setBootstrapInputProvider 接入官方静默识别；观察者完成状态隔离后才允许重试。 */
  setBootstrapInputProvider(
    provider: () => Promise<BootstrapInput>,
    observer?: (result: BootstrapResult) => void | Promise<void>,
  ): void {
    this.bootstrapInputProvider = provider;
    this.bootstrapObserver = observer;
  }


  /** setSessionStateObserver 让运行时在身份封闭后提供用户明确触发的恢复入口。 */
  setSessionStateObserver(observer: (usable: boolean) => void): void {
    this.sessionStateObserver = observer;
  }

  /** setSessionInputProvider 将新版身份安装与配置、广告及权益读取彻底分开。 */
  setSessionInputProvider(provider: () => Promise<BootstrapInput>, observer: (result: SessionResult) => void | Promise<void>): void {
    this.sessionInputProvider = provider;
    this.sessionObserver = observer;
  }

  /** hasSession 只表示本页已经安装身份，不使用设备日期猜测凭据过期。 */
  get hasSession(): boolean { return this.identityUsable && Boolean(this.visitorToken); }

  /** configurePlayback 仅由校验过的应用公开配置决定播放来源。 */
  configurePlayback(config: AppConfig): void { this.playbackProvider = config.playbackSdk.provider; }

  /** createSession 串行安装新凭据，认证失败不重放，也不请求广告配置。 */
  createSession(input: BootstrapInput): Promise<SessionResult> {
    const pending = this.performSession(input, this.bootstrapBarrier);
    const barrier = pending.then(() => undefined, () => undefined);
    this.bootstrapBarrier = barrier;
    void barrier.then(() => { if (this.bootstrapBarrier === barrier) this.bootstrapBarrier = undefined; });
    return pending;
  }

  private async performSession(input: BootstrapInput, previous?: Promise<void>): Promise<SessionResult> {
    await previous;
    const result = await this.request<SessionResult>("/api/v1/session", {
      method: "POST", body: JSON.stringify({ ...input, visitorToken: input.visitorToken || this.visitorToken || undefined }),
    }, false, false);
    if (!result || typeof result.applicationId !== "string" || !result.applicationId.trim() ||
      typeof result.visitorId !== "string" || !result.visitorId.trim() || typeof result.visitorToken !== "string" || !result.visitorToken.trim() ||
      result.tiktokAppId !== input.tiktokAppId || !["anonymous", "tiktok_authenticated"].includes(result.identityState)) {
      throw invalidResponse("Session application or visitor identity is invalid");
    }
    this.identityUsable = false;
    try {
      if (this.identityKey !== JSON.stringify([result.applicationId, result.visitorId])) this.serverClock.changeIdentity(result);
      await this.sessionObserver?.(result);
    } catch (reason) {
      logClientEvent("error", "session_observer_failed", { error: safeErrorMessage(reason) });
      this.sessionStateObserver?.(false);
      throw reason;
    }
    this.visitorToken = result.visitorToken;
    this.identityKey = JSON.stringify([result.applicationId, result.visitorId]);
    this.credentialGeneration += 1;
    this.identityUsable = true;
    this.sessionStateObserver?.(true);
    return result;
  }

  /** appConfig 无凭据并行读取应用级配置，不请求任何个人进度。 */
  async appConfig(tiktokAppId: string): Promise<AppConfig> {
    const result = await this.request<AppConfig>(`/api/v1/open/app-config?tiktokAppId=${encodeURIComponent(tiktokAppId)}`, { cache: "no-store" }, false, false);
    if (!result || result.tiktokAppId !== tiktokAppId || typeof result.applicationId !== "string" || !result.applicationId.trim() ||
      typeof result.appName !== "string" || typeof result.logoUrl !== "string" || typeof result.complianceBaseUrl !== "string" ||
      (result.interstitialAdUnitId !== undefined && typeof result.interstitialAdUnitId !== "string") || !result.monetization?.vip || typeof result.monetization.vip.enabled !== "boolean") {
      throw invalidResponse("Application configuration is invalid");
    }
    if (result.miniReview && (typeof result.miniReview.enabled!=='boolean' || typeof result.miniReview.episodeOnly!=='boolean' || !Number.isSafeInteger(result.miniReview.revision) || result.miniReview.revision<0)) throw invalidResponse('Application review configuration is invalid');
    return result;
  }

  /** prepareCampaignPlayback 无身份请求已发布目标集的公开展示数据，正式起播使用独立的已认证请求。 */
  async prepareCampaignPlayback(tiktokAppId: string, campaignCode: string): Promise<CampaignPlaybackPreparation | null> {
    const query = new URLSearchParams({ tiktokAppId, campaignCode });
    const result = await this.request<CampaignPlaybackPreparation | null>(`/api/v1/open/play/prepare?${query}`, { cache: "no-store" }, false, false);
    if (result === null) return null;
    if (!result?.target || typeof result.target.dramaId !== "string" || typeof result.target.episodeId !== "string" ||
        !result.target.dramaId || !result.target.episodeId || typeof result.coverUrl !== "string" ||
        typeof result.title !== "string" || !Number.isSafeInteger(result.episodeNumber) || !Number.isSafeInteger(result.episodeCount)) {
      throw invalidResponse("Campaign playback preparation is invalid");
    }
    return result;
  }

  /** vipState 只读取个人状态，恢复前台或截止后无需登录及生成广告入口。 */
  async vipState(signal?: AbortSignal): Promise<VIPState> {
    const state = await this.request<VIPState>("/api/v1/me/vip", { signal, cache: "no-store" });
    return this.validateVIPState(state);
  }

  private validateVIPState(state: VIPState): VIPState {
    if (!state || typeof state.active !== "boolean" || !Number.isInteger(state.adCount) || state.adCount < 0 ||
      !Number.isInteger(state.requiredCount) || state.requiredCount < 0 || typeof state.progressDate !== "string" ||
      (state.active && state.validUntil && (remainingServerTime(state) ?? 0) <= 0)) {
      throw invalidResponse("VIP state or its server validity is not confirmed");
    }
    return state;
  }

  /** vipOffer 只在需要展示广告时查询；没有可用入口时返回空值，不假造权益。 */
  async vipOffer(): Promise<AccessOffer | undefined> {
    const result = await this.request<{ offer: AccessOffer | null }>("/api/v1/me/vip/offer", { cache: "no-store" });
    if (!result || !("offer" in result) || (result.offer != null &&
      (result.offer.kind !== "rewarded_vip" || !result.offer.offerId || !result.offer.adUnitId))) {
      throw invalidResponse("VIP offer is invalid");
    }
    return result.offer ?? undefined;
  }

  /** playbackEntry 立即请求目标的门禁和起播结果；冷启动按已确认的应用通道校验回包。 */
  async playbackEntry(input: PlaybackEntryInput, configurationReady?: Promise<void>): Promise<PlaybackEntry | undefined> {
    const response = this.request<{ entry: PlaybackEntry | null }>("/api/v1/play/entry", {
      method: "POST", body: JSON.stringify(input), cache: "no-store",
    });
    // 播放凭据只能按已安装的应用通道解释，配置迟到时保留原回包在内存中等待。
    const [result] = await Promise.all([response, configurationReady]);
    if (result?.entry === null && input.source === "launch") return;
    const entry = result?.entry;
    if (!entry?.target?.dramaId || !entry.target.episodeId || entry.drama?.id !== entry.target.dramaId ||
        entry.episode?.id !== entry.target.episodeId || entry.episode.dramaId !== entry.target.dramaId ||
        (input.source === "selection" && (entry.target.dramaId !== input.dramaId || entry.target.episodeId !== input.episodeId)) ||
        (entry.play && (!["playable", "access_required", "unavailable"].includes(entry.play.status) ||
          (entry.play.status !== "unavailable" && (entry.play.drama?.id !== entry.target.dramaId || entry.play.episode?.id !== entry.target.episodeId))))) {
      throw invalidResponse("Playback entry is invalid");
    }
    this.validateEntryAdStatus(entry.entryAdStatus);
    this.validateVIPState(entry.vipState);
    if (entry.play) entry.play = this.normalizePlayback(entry.play);
    return entry;
  }

  /** requestSequence 是当前页面发起的查询顺序，供运行时阻止领奖前的迟到状态覆盖。 */
  get requestSequence(): number { return this.requestOrder; }

  /** invalidateTime 在离开前台时使已有许可与状态截止点失效，回前台必须取得新响应。 */
  invalidateTime(): void { this.serverClock.invalidate(); }

  /** serverNow 仅返回当前页面前台代次内的服务器时间估计，不使用手机日期补足缺失基准。 */
  serverNow(): number | undefined { return this.serverClock.now(); }

  /** bootstrap 使用官方换码结果建立自有 API 会话，不为失败启动递归登录。 */
  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const previous = this.bootstrapBarrier;
    const pending = this.performBootstrap(input, previous);
    // 屏障只负责等待；调用 bootstrap 的一方接收原错误，避免产生无人消费的拒绝 Promise。
    const barrier = pending.then(() => undefined, () => undefined);
    this.bootstrapBarrier = barrier;
    void barrier.then(() => {
      if (this.bootstrapBarrier === barrier) this.bootstrapBarrier = undefined;
    });
    return pending;
  }

  /** adExperience 复用现有凭据查询权益，不换码、不续签、不重建启动归因。 */
  async adExperience(signal?: AbortSignal): Promise<Pick<BootstrapResult, "monetization" | "vipState" | "vipOffer">> {
    const result = await this.request<Pick<BootstrapResult, "monetization" | "vipState" | "vipOffer">>("/api/v1/me/ad-experience", { signal, cache: "no-store" });
    if (!result?.monetization?.vip || typeof result.monetization.vip.enabled !== "boolean" ||
      !result.vipState || typeof result.vipState.active !== "boolean" || !Number.isInteger(result.vipState.adCount) || result.vipState.adCount < 0 ||
      (result.vipState.active && result.vipState.validUntil && (remainingServerTime(result.vipState) ?? 0) <= 0)) {
      throw invalidResponse("Ad experience or its server validity is not confirmed");
    }
    return result;
  }

  /** entryAdStatus 按当前剧目读取明确的范围与模式；无效合同拒绝放行。 */
  async entryAdStatus(dramaId?: Id): Promise<import("../domain/types").EntryAdStatus> {
    const result = await this.request<import("../domain/types").EntryAdStatus>(`/api/v1/me/entry-ad${dramaId ? `?dramaId=${encodeURIComponent(dramaId)}` : ""}`);
    return this.validateEntryAdStatus(result);
  }

  /** validateEntryAdStatus 让查询与结算回包共用服务端进度校验，不从 SDK 回调合成次数。 */
  private validateEntryAdStatus(result: import("../domain/types").EntryAdStatus): import("../domain/types").EntryAdStatus {
    if (!result || typeof result.enabled !== "boolean" ||
      (result.enabled && (!Number.isInteger(result.completedCount) || !Number.isInteger(result.requiredCount) ||
        result.completedCount < 0 || result.requiredCount < 1 || (remainingServerTime(result) ?? 0) <= 0 ||
        (!["user", "user_drama"].includes(result.scope || "") || !["shown", "completed"].includes(result.countBy || "") || !Number.isInteger(result.shownCount ?? 0) || (result.shownCount ?? 0) < 0) ||
        (!result.offer || result.offer.kind !== "rewarded_entry" || !result.offer.offerId || !result.offer.adUnitId)))) {
      throw invalidResponse("Entry ad status or its server validity is not confirmed");
    }
    return result;
  }

  /** recordAdShow 幂等提交通用展示事实，不申请奖励或权益。 */
  async recordAdShow(show: import("../domain/types").AdShow): Promise<AdShowConfirmation> {
    const result = await this.request<AdShowConfirmation>(show.scene === "entry_reward" ? "/api/v1/me/entry-ad/shows" : "/api/v1/me/ad-shows", { method: "POST", body: JSON.stringify({
      eventId: show.eventId, scene: show.scene, adUnitId: show.adUnitId,
      ...(show.dramaId ? { dramaId: show.dramaId } : {}), ...(show.episodeId ? { episodeId: show.episodeId } : {}),
      ...(show.occurredAt ? { occurredAt: show.occurredAt } : {}),
    }) });
    if (result?.accepted !== true) throw new ApiError("Ad display is not confirmed", 200, "invalid_response");
    if (result.entryAdStatus !== undefined) {
      try { result.entryAdStatus = this.validateEntryAdStatus(result.entryAdStatus); }
      catch (reason) {
        logClientEvent("warn", "confirmed_entry_status_invalid", { error: safeErrorMessage(reason) });
        delete result.entryAdStatus;
      }
    }
    return result;
  }

  /** adShowStatus 读取指定场景的自然日展示，无剧目标的首页等场景仅传 scene。 */
  async adShowStatus(scene: string, dramaId?: Id, episodeId?: Id): Promise<import("../domain/types").AdShowStatus> {
    const query = new URLSearchParams({ scene });
    if (dramaId) query.set("dramaId", dramaId);
    if (episodeId) query.set("episodeId", episodeId);
    const result = await this.request<import("../domain/types").AdShowStatus>(`/api/v1/me/ad-shows?${query}`);
    if (!result || !Number.isInteger(result.shownCount) || result.shownCount < 0 || !result.progressDate || (remainingServerTime(result) ?? 0) <= 0) {
      throw invalidResponse("Ad show progress or its server validity is not confirmed");
    }
    return result;
  }

  /** performBootstrap 等待上次安装结束，观察者成功后才使新凭据可用于业务请求。 */
  private async performBootstrap(input: BootstrapInput, previous?: Promise<void>): Promise<BootstrapResult> {
    await previous;
    const requestInput =
      this.visitorToken && !input.visitorToken
        ? { ...input, visitorToken: this.visitorToken }
        : input;
    const result = await this.request<BootstrapResult>(
      "/api/v1/bootstrap",
      {
        method: "POST",
        body: JSON.stringify(requestInput),
      },
      false,
    );
    if (
      !result || typeof result.applicationId !== "string" || !result.applicationId.trim() ||
      typeof result.visitorId !== "string" || !result.visitorId.trim() ||
      typeof result.visitorToken !== "string" || !result.visitorToken.trim() ||
      result.tiktokAppId !== input.tiktokAppId
    ) {
      const error = new ApiError("Bootstrap application or visitor identity is invalid", 200, "invalid_response");
      logClientEvent("error", "bootstrap_identity_rejected", { error: error.message });
      throw error;
    }
    // 观察者可能校验播放器配置或等待语言资源。失败时不能出现 runtime=A、API=B。
    this.identityUsable = false;
    try {
      if (this.identityKey !== JSON.stringify([result.applicationId, result.visitorId])) this.serverClock.changeIdentity(result);
      await this.bootstrapObserver?.(result);
      this.playbackProvider = result.playbackSdk?.provider ?? "tiktok_minis";
    } catch (error) {
      logClientEvent("error", "bootstrap_observer_failed", { error: safeErrorMessage(error) });
      this.sessionStateObserver?.(false);
      throw error;
    }
    this.visitorToken = result.visitorToken;
    this.identityKey = JSON.stringify([result.applicationId, result.visitorId]);
    this.credentialGeneration += 1;
    this.identityUsable = true;
    this.sessionStateObserver?.(true);
    return result;
  }

  /** homeCarousel 公开读取当前应用轮播，不发送凭据或等待其他首页区域。 */
  async homeCarousel(tiktokAppId: string): Promise<HomeSections["carousel"]> {
    return this.homeDramas(tiktokAppId, "carousel");
  }

  /** homeHot 公开读取当前应用人工热播，不发送凭据或等待其他首页区域。 */
  async homeHot(tiktokAppId: string): Promise<HomeSections["hot"]> {
    return this.homeDramas(tiktokAppId, "hot");
  }

  /** homeRankings 公开读取当前应用分类榜，不发送凭据或阻塞轮播与热播。 */
  async homeRankings(tiktokAppId: string): Promise<NonNullable<HomeSections["rankings"]>> {
    const result = await this.request<NonNullable<HomeSections["rankings"]>>(
      `/api/v1/open/home/rankings?tiktokAppId=${encodeURIComponent(tiktokAppId)}`, {}, false,
    );
    if (!Array.isArray(result) || result.some(item => !item || typeof item.tagId !== "string" || typeof item.name !== "string" || !Array.isArray(item.dramas))) {
      logClientEvent("error", "home_rankings_invalid", { error: "Homepage rankings are invalid" });
      throw new ApiError("Homepage rankings are invalid", 200, "invalid_response");
    }
    return result;
  }

  /** homeRankingCategories 只读取分类名称与 ID，不下载所有分类的剧目。 */
  async homeRankingCategories(tiktokAppId: string): Promise<HomeRankingCategory[]> {
    const result = await this.request<HomeRankingCategory[]>(
      `/api/v1/open/home/ranking-categories?tiktokAppId=${encodeURIComponent(tiktokAppId)}`, {}, false,
    );
    if (!Array.isArray(result) || result.some(item => !item || typeof item.tagId !== "string" || !item.tagId || typeof item.name !== "string")) {
      throw invalidResponse("Homepage ranking categories are invalid");
    }
    return result;
  }

  /** homeRankingPage 公开读取所选分类的一页摘要，分类身份不匹配时拒绝响应，避免切换后串数据。 */
  async homeRankingPage(tiktokAppId: string, tagId: string, input: Pick<DiscoveryQuery, "cursor" | "limit"> = {}): Promise<HomeRankingPage> {
    const query = new URLSearchParams({ tiktokAppId, limit: String(input.limit ?? 20) });
    if (input.cursor) query.set("cursor", input.cursor);
    const result = await this.request<HomeRankingPage>(
      `/api/v1/open/home/rankings/${encodeURIComponent(tagId)}?${query.toString()}`, {}, false,
    );
    if (!result || result.tagId !== tagId || typeof result.name !== "string" || !Array.isArray(result.dramas) ||
      result.dramas.length > (input.limit ?? 20) || (result.nextCursor !== undefined && typeof result.nextCursor !== "string") ||
      (result.nextCursor && result.nextCursor === input.cursor)) {
      throw invalidResponse("Homepage ranking page is invalid");
    }
    return result;
  }

  private async homeDramas(tiktokAppId: string, section: "carousel" | "hot"): Promise<HomeSections["carousel"]> {
    const result = await this.request<HomeSections["carousel"]>(
      `/api/v1/open/home/${section}?tiktokAppId=${encodeURIComponent(tiktokAppId)}`, {}, false,
    );
    if (!Array.isArray(result)) {
      logClientEvent("error", `home_${section}_invalid`, { error: `Homepage ${section} is invalid` });
      throw new ApiError(`Homepage ${section} is invalid`, 200, "invalid_response");
    }
    return result;
  }



  home(): Promise<HomePayload> {
    return this.request<HomePayload>("/api/v1/home");
  }

  /** publicCatalog 独立于登录读取当前应用公开目录，不发送凭据或触发身份恢复。 */
  async publicCatalog(tiktokAppId: string, input: DiscoveryQuery = {}): Promise<HomePayload> {
    const query = discoverySearchParams(input);
    query.set("tiktokAppId", tiktokAppId);
    const result = await this.request<HomePayload & { tiktokAppId: string }>(
      `/api/v1/open/catalog?${query.toString()}`, {}, false,
    );
    if (result.tiktokAppId !== tiktokAppId || !Array.isArray(result.dramas)) {
      logClientEvent("error", "public_catalog_invalid", { error: "Public catalog application or dramas is invalid" });
      throw new ApiError("Public catalog is invalid", 200, "invalid_response");
    }
    return { dramas: result.dramas, ...(result.tags ? { tags: result.tags } : {}), ...(result.nextCursor ? {nextCursor:result.nextCursor} : {}) };
  }

  discover(input: DiscoveryQuery = {}): Promise<DiscoveryPage> {
    const query = discoverySearchParams(input);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<DiscoveryPage>(`/api/v1/discovery${suffix}`);
  }

  drama(dramaId: Id): Promise<DramaDetail> {
    return this.request<DramaDetail>(
      `/api/v1/dramas/${encodeURIComponent(dramaId)}`,
    );
  }

  /** resolvePlay 请求当前剧集的业务验权结果，诊断只记录状态与标识，不输出播放凭据。 */
  async resolvePlay(
    dramaId: Id,
    episodeId: Id,
  ): Promise<PlayResolveResult> {
    const result = this.normalizePlayback(await this.request<PlayResolveResult>("/api/v1/play/resolve?entryPreview=1", {
      method: "POST",
      body: JSON.stringify({ dramaId, episodeId }),
    }));
    logClientEvent("info", "playback_authorization_resolved", {
      dramaId, episodeId, outcome: result.status,
      provider: result.status === "playable" ? result.playback.provider : undefined,
      vid: result.status === "playable" ? result.playback.vid : undefined,
    });
    return result;
  }

  /** resolvePlayBatch 合并相邻集验权请求，返回顺序与 episodeIds 一致。 */
  async resolvePlayBatch(
    dramaId: Id,
    episodeIds: Id[],
  ): Promise<PlayResolveResult[]> {
    return this.request<PlayResolveResult[]>("/api/v1/play/resolve-batch?entryPreview=1", {
      method: "POST",
      body: JSON.stringify({ dramaId, episodeIds }),
    }).then(results => results.map(result => this.normalizePlayback(result)));
  }

  /** claimReward 仅接受匹配 ClaimID 的明确结算或入剧已达标响应，随后清除待确认记录。 */
  async claimReward(claim: RewardClaim): Promise<ClaimResult> {
    const result = await this.request<ClaimResult>("/api/v1/reward-grants", {
      method: "POST",
      body: JSON.stringify({
        claimId: claim.claimId,
        offerId: claim.offerId,
        dramaId: claim.dramaId || "",
        episodeId: claim.episodeId || "",
        completedAdUnitId: claim.adUnitId,
        isEnded: true,
      }),
    });
    if (
      !result || result.claimId !== claim.claimId ||
      !["granted", "already_granted", "entry_satisfied"].includes(result.status) ||
      (result.status === "entry_satisfied" && (result.rewardType !== "entry_progress" || result.unlocked || result.playback !== undefined || result.vipState !== undefined)) ||
      !["episode_unlock", "vip_progress", "entry_progress"].includes(result.rewardType) ||
      typeof result.unlocked !== "boolean"
    ) {
      throw new ApiError("Reward settlement is not confirmed", 200, "invalid_response");
    }
    if (result.playback !== undefined) {
      try {
        if (result.rewardType !== "episode_unlock" || !result.unlocked || result.playback?.status !== "playable") {
          throw invalidResponse("Settled reward playback is invalid");
        }
        result.playback = this.normalizePlayback(result.playback);
      } catch {
        // 许可校验已记录具体拒绝原因；临时许可失效不能推翻服务端已确认的奖励和下一集提示。
        delete result.playback;
        logClientEvent("info", "reward_playback_refresh_required", {
          flow: "reward_claim", stage: "playback", outcome: "settlement_confirmed",
          dramaId: result.dramaId, episodeId: result.episodeId,
        });
      }
    }
    // 新字段仅补充结算后的展示状态；无效字段不能推翻已确认奖励，保留旧接口查询恢复路径。
    if (result.entryAdStatus !== undefined) {
      try {
        if (result.rewardType !== "entry_progress") throw invalidResponse("Unexpected entry ad state");
        result.entryAdStatus = this.validateEntryAdStatus(result.entryAdStatus);
      } catch (reason) {
        logClientEvent("warn", "reward_entry_status_invalid", { error: safeErrorMessage(reason) });
        delete result.entryAdStatus;
      }
    }
    if (result.drama !== undefined && (result.rewardType !== "episode_unlock" || !result.drama ||
        result.drama.id !== result.dramaId || !Array.isArray(result.drama.episodes) ||
        !result.drama.episodes.some(episode => episode?.id === result.episodeId) ||
        result.drama.episodes.some(episode => !episode || typeof episode.id !== "string" ||
          episode.dramaId !== result.dramaId || !["free", "rewarded", "unlocked"].includes(episode.accessMode || "")))) {
      logClientEvent("warn", "reward_directory_invalid", { error: "Settled drama access state is invalid" });
      delete result.drama;
    }
    return result;
  }

  /** claimVIP 仅提交领取动作，进度与身份由服务端根据当前会话核对。 */
  async claimVIP(): Promise<VIPState> {
    const state = await this.request<VIPState>("/api/v1/vip/claim", { method: "POST" });
    if (!state || state.active !== true || !Number.isInteger(state.adCount) ||
      !Number.isInteger(state.requiredCount) || typeof state.progressDate !== "string") {
      throw new ApiError("VIP claim is not confirmed", 200, "invalid_response");
    }
    return state;
  }

  unlocks(): Promise<UnlockRecord[]> {
    return this.request<UnlockRecord[]>("/api/v1/me/unlocks");
  }

  /** collectMetrics 不触发身份恢复，采集故障不能打断播放或反复静默登录。 */
  collectMetrics(events: MetricEvent[]): Promise<{ accepted: boolean }> {
    return this.request("/api/v1/metrics", { method: "POST", body: JSON.stringify({ events }) }, true, false);
  }

  /** reportAdErrors 只发送广告错误现场；401 不恢复身份，失败不重试。 */
  reportAdErrors(events: AdErrorEvent[]): Promise<{ accepted: boolean }> {
    return this.request("/api/v1/ad-errors", { method: "POST", body: JSON.stringify({ events }) }, true, false);
  }

  /** normalizePlayback 只认可当前应用的公开合同，Token 不进入储存或日志。 */
  private normalizePlayback(result: PlayResolveResult): PlayResolveResult {
    if (result.status !== "playable") {
      // 未通过权益判定的直连响应不能夹带媒体预热或起播凭据。
      if (this.playbackProvider === "byteplus_web" &&
          (("preload" in result && result.preload) || ("playback" in result && result.playback))) {
        throw invalidResponse("Unexpected playback credentials", 502);
      }
      if (result.status === "unavailable" || !result.entryPreview) return result;
      const { seconds, playback } = result.entryPreview;
      if (result.episode.number !== 1 || !Number.isInteger(seconds) || seconds < 4 || seconds > 300 ||
          (playback && (playback.episodeNumber !== 1 || (this.playbackProvider === "byteplus_web" &&
            !(playback.durationSeconds > 0 && playback.durationSeconds <= seconds))))) {
        throw invalidResponse("First episode playback response is invalid", 502);
      }
      return playback ? { ...result, entryPreview: { seconds, playback: this.normalizePlaybackSource(playback) } } : result;
    }
    return { ...result, playback: this.normalizePlaybackSource(result.playback) };
  }

  /** 正片与首集片段使用相同的通道和短期凭据校验。 */
  private normalizePlaybackSource(source: PlaybackIdentity): PlaybackIdentity {
    if (!source) throw invalidResponse("Playback response is invalid", 502);
    if (this.playbackProvider === "byteplus_web") {
      if (!source.vid || !source.playAuthToken || source.albumId || source.episodeId ||
          !Number.isFinite(Date.parse(source.expiresAt || "")) || (remainingServerTime(source) ?? 0) <= timePolicy.playbackRefreshAheadMs) {
        throw invalidResponse("Playback authorization lifetime is unconfirmed or insufficient", 502);
      }
    } else if (source.playAuthToken || !source.albumId || !source.episodeId) {
      throw invalidResponse("Official playback identifiers are unavailable", 502);
    }
    return { ...source, provider: this.playbackProvider };
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    authenticate = true,
    recoverVisitor = true,
    identity: RequestIdentity = { key: this.identityKey, generation: this.credentialGeneration },
  ): Promise<T> {
    if (authenticate) {
      await this.bootstrapBarrier;
      this.assertIdentity(identity);
    }
    // 日志只保留稳定路径，不写入搜索词、归因参数或其他查询值。
    const startedAt = performance.now();
    const timeGeneration = this.serverClock.generation;
    const order = ++this.requestOrder;
    const requestStage = path.split("?", 1)[0];
    const headers = new Headers(init.headers);
    headers.set('X-Mini-Version',miniAppVersion());
    // 无请求体的公开 GET 保持简单请求，避免无用 JSON 头触发跨域预检。
    if (init.body !== undefined && init.body !== null) headers.set("content-type", "application/json");
    if (authenticate && this.visitorToken) {
      headers.set("authorization", `Bearer ${this.visitorToken}`);
    }
    const timeout = new AbortController();
    let stopTimeout: (() => void) | undefined;
    let cancelRequest: (() => void) | undefined;
    logClientEvent("debug", "api_request_started", {
      flow: "consumer_api",
      stage: requestStage,
      outcome: "started",
    });
    let response: Response;
    let payload: Envelope<T>;
    try {
      // 超时覆盖响应体读取，不能在收到响应头时就关闭计时器，否则领奖会无限挂起。
      const cancellation = new Promise<never>((_resolve, reject) => {
        stopTimeout = foregroundTimeout(() => {
          reject(new ApiError("Request timed out", 0, "request_timeout"));
          timeout.abort();
        }, this.requestTimeoutMs);
        cancelRequest = () => {
          reject(new ApiError("Request cancelled", 0, "request_cancelled"));
          timeout.abort();
        };
        if (init.signal?.aborted) cancelRequest();
        else init.signal?.addEventListener("abort", cancelRequest, { once: true });
      });
      const transport = async () => {
        if (timeout.signal.aborted) throw new ApiError("Request cancelled", 0, "request_cancelled");
        const fetched = await this.fetcher(
        `${this.baseUrl.replace(/\/$/, "")}${path}`,
        {
          ...init,
          headers,
          signal: timeout.signal,
        },
      );
        let body: unknown;
        try {
          body = await fetched.json();
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
          const failure = new ApiError("Response could not be decoded", fetched.status, "invalid_response", fetched.headers.get("x-request-id") || undefined);
          failure.cause = reason;
          throw failure;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new ApiError("Response envelope is invalid", fetched.status, "invalid_response", fetched.headers.get("x-request-id") || undefined);
        }
        return { response: fetched, payload: body as Envelope<T> };
      };
      ({ response, payload } = await Promise.race([transport(), cancellation]));
    } catch (reason) {
      const failure = reason instanceof ApiError ? reason : new ApiError(
        "Network request failed", 0, "network_error",
      );
      if (!(reason instanceof ApiError)) failure.cause = reason;
      logClientEvent(failure.code === "request_cancelled" ? "debug" : "error", "api_request_failed", {
        error: safeErrorMessage(reason instanceof Error && reason.cause !== undefined ? reason.cause : reason),
        flow: "consumer_api",
        stage: requestStage,
        outcome: failure.code, elapsedMs: performance.now() - startedAt,
        errorType: reason instanceof Error ? reason.name : typeof reason,
      });
      throw failure;
    } finally {
      stopTimeout?.();
      if (cancelRequest) init.signal?.removeEventListener("abort", cancelRequest);
    }
    const requestId = response.headers.get("x-request-id") || undefined;
    if (authenticate) {
      // 响应返回时也可能正有显式刷新；先等安装完成，再决定是否恢复或接受旧响应。
      await this.bootstrapBarrier;
      this.assertIdentity(identity);
    }
    if (
      authenticate &&
      recoverVisitor &&
      (this.sessionInputProvider || this.bootstrapInputProvider) &&
      response.status === 401 &&
      payload.reason === "unauthorized"
    ) {
      await this.refreshVisitor(identity);
      this.assertIdentity(identity);
      return this.request<T>(path, init, authenticate, false, identity);
    }
    if (!response.ok || payload.code > 0) {
      logClientEvent("warn", "api_request_rejected", {
        flow: "consumer_api", stage: requestStage, outcome: `http_${response.status}`, requestId,
      });
      throw new ApiError(
        payload.message || `Request failed with HTTP ${response.status}`,
        response.status,
        payload.reason,
        requestId,
      );
    }
    if (payload.data === undefined) {
      throw invalidResponse("Response data is missing", response.status, requestId);
    }
    logClientEvent("debug", "api_request_succeeded", {
      flow: "consumer_api",
      stage: requestStage,
      outcome: "success", elapsedMs: performance.now() - startedAt,
      requestId,
    });
    return this.serverClock.bind(payload.data, payload.serverTime, startedAt, timeGeneration, order);
  }

  /** assertIdentity 阻止旧账号的成功响应或重试作用于当前账号。 */
  private assertIdentity(identity: RequestIdentity): void {
    if (!this.identityUsable) {
      throw new ApiError("Viewer state could not be restored", 503, "identity_unavailable");
    }
    if (identity.key !== this.identityKey) {
      logClientEvent("warn", "api_identity_changed", {
        flow: "consumer_api", stage: "identity_guard", outcome: "replay_blocked",
      });
      throw identityChangedError();
    }
  }

  /** refreshVisitor 每代凭据只恢复一次；网络、依赖、限流和业务错误不进入此流程。 */
  private async refreshVisitor(identity: RequestIdentity): Promise<void> {
    if (!this.sessionInputProvider && !this.bootstrapInputProvider) return;
    // 新凭据已就绪时，迟到的旧 401 直接使用当前会话；不得再次调用官方 login。
    if (this.visitorRefresh?.generation === identity.generation) {
      await this.visitorRefresh.promise;
      return;
    }
    if (identity.generation !== this.credentialGeneration) return;
    logClientEvent("info", "visitor_recovery_started", {
      flow: "identity", stage: "silent_recovery", outcome: "started",
    });
    const promise = Promise.resolve().then(async () => {
      if (this.sessionInputProvider) await this.createSession(await this.sessionInputProvider());
      else await this.bootstrap(await this.bootstrapInputProvider!());
    })
        .then(() => {
          logClientEvent("info", "visitor_recovery_succeeded", {
            flow: "identity", stage: "silent_recovery", outcome: "success",
          });
        })
        .catch((error: unknown) => {
          // 允许之后新发出的请求恢复临时失败；已发出的旧请求仍共享本次失败。
          if (this.credentialGeneration === identity.generation) this.credentialGeneration += 1;
          logClientEvent("warn", "visitor_recovery_failed", {
            flow: "identity", stage: "silent_recovery", outcome: "failed",
            errorType: error instanceof ApiError ? error.code : "identity_unavailable",
          });
          throw error;
        });
    this.visitorRefresh = { generation: identity.generation, promise };
    await promise;
  }

}

/** discoverySearchParams 保持公开目录与已登录发现页的筛选、分页参数一致。 */
function discoverySearchParams(input: DiscoveryQuery): URLSearchParams {
  const query = new URLSearchParams();
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.tag?.trim()) query.set("tag", input.tag.trim());
  if (input.status) query.set("status", input.status);
  if (input.cursor?.trim()) query.set("cursor", input.cursor.trim());
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return query;
}
