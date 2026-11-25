import type { Id } from "./id";
import type { TimedValue } from "./serverTime";

/** SessionResult 是新版独立认证结果，不依赖应用配置、权益或广告入口。 */
export type SessionResult = Pick<BootstrapResult, "applicationId" | "tiktokAppId" | "visitorId" | "visitorToken" | "identityState" | "tiktokOpenId" | "campaign">;

/** AppConfig 是无身份的应用配置，与个人状态分开加载。 */
export type AppConfig = Pick<BootstrapResult, "applicationId" | "tiktokAppId" | "appName" | "logoUrl" | "complianceBaseUrl" | "interstitialAdUnitId" | "monetization" | "playbackSdk" | "miniReview">;

/** AdShowConfirmation 确认事实已保存，入剧场景可直接应用服务器返回的最新进度。 */
export interface AdShowConfirmation {
  /** accepted 为 true 后不得因状态读取失败重新创建事实键。 */
  accepted: boolean;
  /** entryAdStatus 是当前服务器自然日的入剧进度；故障时可单独恢复读取。 */
  entryAdStatus?: EntryAdStatus;
}

/** BootstrapResult 是服务端确认的应用及用户启动上下文。 */
export interface BootstrapResult {
  /** miniReview 是当前版本的有效审核状态，不包含运营内容清单。 */
  miniReview?: {
    /** enabled 决定首页清单是否生效。 */
    enabled: boolean;
    /** episodeOnly 仅在纯 IAA 审核版本中为真。 */
    episodeOnly: boolean;
    /** revision 用于隔离首页缓存与分页。 */
    revision: number;
  };
  /** interstitialAdUnitId 是应用配置的普通插屏位，不参与奖励结算。 */
  interstitialAdUnitId?: string;
  // TikTokOpenId 只供当前用户向官方回传事件，不能持久化或输出日志。
  tiktokOpenId?: string;
  /** applicationId 是数据库自增主键的十进制字符串，与官方 AppID 不同。 */
  applicationId: Id;
  /** tiktokAppId 必须与当前构建配置的官方 AppID 一致。 */
  tiktokAppId: string;
  /** visitorId 是当前应用内的持久业务主体。 */
  visitorId: Id;
  /** visitorToken 是自有 API 访问凭据，禁止写入日志。 */
  visitorToken: string;
  /** appName 是服务端确认的应用展示名称。 */
  appName: string;
  /** logoUrl 是当前应用的公开图标地址。 */
  logoUrl: string;
  /** complianceBaseUrl 是当前应用的合规页面基础地址。 */
  complianceBaseUrl: string;
  /** identityState 表示匿名开发主体或已绑定的官方身份。 */
  identityState: "anonymous" | "tiktok_authenticated";
  /** vipState 是服务端当前确认的 VIP 进度与权益。 */
  vipState: VIPState;
  /** monetization 是应用公开的变现规则。 */
  monetization: ApplicationMonetization;
  /** vipOffer 是当前可用的 VIP 激励广告入口。 */
  vipOffer?: AccessOffer;
  /** launchTarget 是服务端确认可见的启动落地剧集。 */
  launchTarget?: LaunchTarget;
  /** campaign 是当前应用解析出的投放归因。 */
  campaign?: CampaignAttribution;
  /** playbackSdk 限定当前应用的固定播放器和媒资通道。 */
  playbackSdk: PlaybackSDKConfig;
}

// PlaybackSDKConfig 声明应用固定的播放通道，直连 License 由 Mini 随包提供。
// 启动配置不携带 License 内容、云访问密钥或长期播放凭据。
export interface PlaybackSDKConfig {
  // provider 由服务端应用配置决定，客户端不能自行切换通道。
  provider: "tiktok_minis" | "byteplus_web";
  /** capabilities 限定直连基础版能力，mediaPreload 必须为 false。 */
  capabilities?: {
    /** mediaPreload 必须为 false，直连基础版不启用高级媒体预加载。 */
    mediaPreload: boolean;
  };
  // channel 固定为当前媒资所在的 BytePlus VOD 通道。
  channel: "byteplus";
}

export interface CampaignAttribution {
  id: Id;
  code: string;
  dramaId?: Id;
  episodeId?: Id;
  experimentKey?: string;
}

export interface LaunchTarget {
  dramaId: Id;
  episodeId: Id;
}

/** CampaignPlaybackPreparation 是访客身份就绪前可用的公开投放剧集摘要。 */
export interface CampaignPlaybackPreparation {
  /** target 是当前应用线上版本中的业务剧目和分集。 */
  target: { dramaId: Id; episodeId: Id };
  /** coverUrl 是目标集海报，缺失时由服务端使用剧封面。 */
  coverUrl: string;
  /** title 是发布版本的剧名。 */
  title: string;
  /** episodeNumber 是目标集序号。 */
  episodeNumber: number;
  /** episodeCount 是发布版本包含的总集数。 */
  episodeCount: number;
}

/** PlaybackEntryInput 区分服务器确认的投放落地与当前用户显式点选。 */
export type PlaybackEntryInput =
  | { /** source 指定使用本次会话归因。 */ source: "launch"; /** launchQuery 是原启动参数。 */ launchQuery: Record<string, string> }
  | { /** source 指定使用显式点选。 */ source: "selection"; /** dramaId 是短剧标识。 */ dramaId: Id; /** episodeId 是目标集标识。 */ episodeId: Id };

/** PlaybackEntry 返回当前目标的首屏、门禁及有权使用的播放决策。 */
export interface PlaybackEntry {
  /** target 是服务端确认可见的内部剧目和剧集。 */
  target: LaunchTarget;
  /** drama 供详情首屏使用，不包含完整目录。 */
  drama: DramaSummary;
  /** episode 是目标集展示信息。 */
  episode: Episode;
  /** entryAdStatus 是当前应用和剧目的入剧广告进度。 */
  entryAdStatus: EntryAdStatus;
  /** vipState 是当前用户的权威 VIP 状态。 */
  vipState: VIPState;
  /** play 仅在服务端可交付当前播放许可或解锁决策时提供。 */
  play?: PlayResolveResult;
}

/** VIPState 保存服务端确认的进度与权益；本地截止点仅用于安排重新查询。 */
export interface VIPState extends TimedValue {
  /** responseOrder 是本地请求顺序，用于拒绝领奖前发出的迟到状态；不进入 API 请求。 */
  responseOrder?: number;
  /** active 是服务端最近确认的 VIP 事实，时间待刷新时不自行改写。 */
  active: boolean;
  /** adCount 是服务端按应用自然日结算的完整广告次数。 */
  adCount: number;
  /** requiredCount 是当前规则允许手动领取 VIP 的阈值。 */
  requiredCount: number;
  /** validUntil 是服务端确认的权益截止时刻，省略表示该权益没有期限。 */
  validUntil?: string;
  /** progressDate 是应用时区下的服务端自然日键。 */
  progressDate: string;
}

export interface EpisodeRewardPolicy {
  unlockEpisodeCount: number;
  dailyRewardLimit: number;
}

export interface ApplicationVIPPolicy {
  enabled: boolean;
  /** requireBeforePlayback 缺省关闭；新版 Mini 在入剧广告已达标或未启用后检查 VIP 领取。 */
  requireBeforePlayback?: boolean;
  /** entryAdCountdownSeconds 为 VIP 入剧强弹每次自动拉起前的前台倒计时，0 或省略立即拉起。 */
  entryAdCountdownSeconds?: number;
  requiredAdCount: number;
  delaySeconds?: number;
  title: string;
  content: string;
  failureMessage?: string;
}

// 面向客户端、归应用所有的 IAA 控制项；版本及其他结算
// 标识符绝不跨越消费者 API 边界。
export interface ApplicationMonetization {
  status: "enabled" | "disabled";
  strategy: "episode_reward" | "episode_unlock" | "rules";
  freeEpisodeCount: number;
  /** entryAdDelaySeconds 指定剧集详情在前台累计可见多少秒后执行首次广告门禁，零表示确认资格后立即执行。 */
  entryAdDelaySeconds?: number;
  episodeReward: EpisodeRewardPolicy;
  vip: ApplicationVIPPolicy;
}

/** AutoUnlockConfig 只控制逐集广告后的提示，所有奖励和播放仍须 API 验权。 */
export interface AutoUnlockConfig {
  /** enabled 缺省关闭，保持旧策略广告结束后直接播放。 */
  enabled: boolean;
  /** countdownSeconds 为前台倒计时秒数，未提供时默认 5 秒。 */
  countdownSeconds?: number;
  /** title 留空使用默认英语标题。 */
  title?: string;
  /** content 留空使用默认英语说明。 */
  content?: string;
}

export interface AccessOffer {
  /** autoUnlock 属于本条服务端 Offer，不能从其他规则借用。 */
  autoUnlock?: AutoUnlockConfig;
  /** promptOnIncomplete 缺省关闭，仅控制未看完逐集广告后的续看提示。 */
  promptOnIncomplete?: boolean;
  /** incompleteAdCountdownSeconds 是未看完广告后的重看倒计时；旧 Offer 缺省三秒。 */
  incompleteAdCountdownSeconds?: number;
  /** incompleteAdDisplayCountdownSeconds 是弹窗数字的起点；在实际重看等待时间内走到零，缺省与等待秒数相同。 */
  incompleteAdDisplayCountdownSeconds?: number;
  /** 获取方式决定客户端策略；未知方式不会显示可执行入口。 */
  method?: string;
  /** 当前共享策略内的稳定入口编码。 */
  ruleCode?: string;
  /** 此入口授予的权益类别，仅供展示。 */
  benefits?: string[];
  /** 该广告 VIP 入口独立的阈值和文案。 */
  vip?: ApplicationVIPPolicy;
  /** 此入口所属规则的服务端广告进度。 */
  vipState?: VIPState;
  offerId: string;
  adUnitId: string;
  kind:
    | "rewarded_episode"
    | "rewarded_vip"
    | "rewarded_entry";
}

/** EntryAdStatus 是服务端确认的当前自然日入剧广告进度，不是播放凭据。 */
export interface EntryAdStatus extends TimedValue {
  /** responseOrder 是本页请求顺序，避免迟到确认覆盖更新的进度。 */
  readonly responseOrder?: number;
  /** scope 根据配置选择所有剧共享或每人每剧独立计数。 */
  scope?: "user" | "user_drama";
  /** countBy 决定 Mini 使用成功展示或完整观看进度。 */
  countBy?: "shown" | "completed";
  /** shownCount 仅统计当前范围内官方 SDK 已确认的展示，提前关闭也计入。 */
  shownCount?: number;
  /** enabled 表示后台已启用入剧广告门槛。 */
  enabled: boolean;
  /** completedCount 只包含成功结算的广告次数。 */
  completedCount: number;
  /** requiredCount 是进入任一短剧播放前需要完成的次数。 */
  requiredCount: number;
  /** progressDate 是应用时区的自然日键。 */
  progressDate?: string;
  /** validUntil 是本次进度的截止时刻，跨天后必须重新读取。 */
  validUntil?: string;
  /** offer 在启用规则时提供事实采集入口，由 Mini 判断是否仍需展示。 */
  offer?: AccessOffer;
}

/** AdShow 是 SDK 已确认的跨场景展示事实，不作为完整观看、奖励或播放凭据。 */
export interface AdShow {
  /** eventId 固定一次展示的幂等键，领奖场景可复用原 ClaimID。 */
  eventId: string;
  /** scene 是用途编码，首页等新场景可复用同一合同。 */
  scene: string;
  /** adUnitId 是当前应用登记且实际展示的公开广告位。 */
  adUnitId: string;
  /** dramaId 是可选来源剧目，无内容目标时省略。 */
  dramaId?: Id;
  /** episodeId 是可选来源剧集，存在时同时提供剧目。 */
  episodeId?: Id;
  /** occurredAt 仅兼容读取旧待补报记录；新展示无需提交手机时间，服务器按首次接收日确认。 */
  occurredAt?: string;
  /** queuedAtServer 仅用于本地待补报保留期，不发送给 API，也不决定业务事实归日。 */
  queuedAtServer?: number;
}

/** AdShowStatus 是服务端查询的场景每日展示事实，门槛与放行结论由 Mini 判断。 */
export interface AdShowStatus extends TimedValue {
  /** shownCount 是认证用户在该场景及可选内容范围内的成功展示次数。 */
  shownCount: number;
  /** progressDate 是应用时区的自然日日期。 */
  progressDate: string;
  /** validUntil 是下一应用当地午夜的 UTC 时刻。 */
  validUntil: string;
}

/** AdExperience 汇总当前主体的广告规则、VIP 事实及待重新确认状态。 */
export interface AdExperience {
  /** refreshRequired 表示时间或前台状态需要重新向服务器确认，不能自行撤销或授予 VIP。 */
  refreshRequired?: boolean;
  /** refreshError 是受控刷新失败后的安全提示，供现有恢复入口展示。 */
  refreshError?: string;
  /** vipState 保存已确认的进度与权益，不能由手机日期模拟。 */
  vipState: VIPState;
  /** monetizationPolicy 是当前应用公开的变现规则。 */
  monetizationPolicy: ApplicationMonetization;
  /** vipOffer 是当前服务端允许使用的广告入口。 */
  vipOffer?: AccessOffer;
}

export interface DramaSummary {
  id: Id;
  firstEpisodeId: Id;
  /** 第一集首帧图；兼容尚未返回此字段的接口和本地缓存。 */
  firstEpisodePosterUrl?: string;
  title: string;
  description: string;
  coverUrl: string;
  episodeCount: number;
  tags: string[];
  status: "ongoing" | "completed";
}

export interface Episode {
  id: Id;
  dramaId: Id;
  number: number;
  title: string;
  description: string;
  posterUrl: string;
  durationSeconds: number;
  accessMode: "free" | "rewarded" | "unlocked";
}

/** DramaDetail 只包含当前应用线上内容，不携带编辑状态或管理端发布版本。 */
export interface DramaDetail extends DramaSummary {
  /** episodes 是当前上线内容中的分集，渠道更新后重新读取即可。 */
  episodes: Episode[];
}

export interface ContinueWatchingItem {
  drama: DramaSummary;
  episodeId: Id;
  episodeNumber: number;
  progressSeconds: number;
  durationSeconds: number;
}

export interface HomePayload {
  /** tags 是当前应用所有已发布剧目的可选分类；兼容尚未返回分类的服务端。 */
  tags?: string[];
  /** nextCursor 是下一页摘要游标。 */
  nextCursor?: string;
  dramas: DramaSummary[];
}

export interface DiscoveryQuery {
  /** placement 仅首页显式设置；搜索和其他目录读取不受首页清单限制。 */
  placement?: 'home';
  query?: string;
  tag?: string;
  status?: "ongoing" | "completed";
  cursor?: string;
  limit?: number;
}

export interface DiscoveryPage {
  items: DramaSummary[];
  nextCursor?: string;
  tags: string[];
}

export interface FollowedDrama {
  drama: DramaSummary;
  createdAt: string;
}

export interface UnlockRecord {
  drama: DramaSummary;
  episode: Episode;
  grantedAt: string;
  expiresAt?: string;
}

// PlaybackIdentity 是服务端完成内容和权益校验后下发的官方 Player 播放描述符。
// 其中看似数字的平台标识仍必须按字符串传递。
export interface PlaybackIdentity extends TimedValue {
  /** provider 由启动配置确定，历史官方描述符省略时仍为官方。 */
  provider?: "tiktok_minis" | "byteplus_web";
  /** playAuthToken 只在内存保留，直连播放使用。 */
  playAuthToken?: string;
  /** expiresAt 限制相邻集缓存与失败重试。 */
  expiresAt?: string;
  // channel 必须与 Bootstrap 声明的官方通道一致。
  channel: "byteplus";
  // albumId 是 TikTok 审核通过的短剧 Album 字符串标识。
  albumId?: string;
  // episodeId 是 TikTok 审核通过的剧集字符串标识。
  episodeId?: string;
  // vid 是对应 BytePlus VOD 媒资的字符串标识。
  vid: string;
  // posterUrl 是官方 Player 出现首帧前的过渡封面。
  posterUrl: string;
  // title 是当前语言下的剧集标题。
  title: string;
  // episodeNumber 是当前剧集在短剧中的顺序。
  episodeNumber: number;
  // durationSeconds 是运营媒资中记录的预期时长。
  durationSeconds: number;
}

export type PlayResolveResult =
  | {
      status: "playable";
      drama: DramaSummary;
      episode: Episode;
      playback: PlaybackIdentity;
      vipState?: VIPState;
    }
  | {
      status: "access_required" | "reward_ad_required";
      drama: DramaSummary;
      episode: Episode;
      /** 按策略优先级排列的已接入获取方式。 */
      offers?: AccessOffer[];
      offer: AccessOffer;
      /** 仅供官方播放器预加载媒资；必须取得 playable 后才能起播。 */
      preload?: PlaybackIdentity;
      /** 首集仍需解锁，片段准备完成前仅返回秒数。 */
      entryPreview?: {
        /** 首集播放到这个时间点才继续原广告策略。 */
        seconds: number;
        /** 官方标识或直连短片凭据，直连正片仍须验权。 */
        playback?: PlaybackIdentity;
      };
      vipOffer?: AccessOffer;
      adUnitId?: string;
      vipState?: VIPState;
    }
  | {
      status: "unavailable";
    };

// RewardClaim 在广告展示前生成，并在 TikTok 返回 isEnded=true 后提交。
// claimId 在离线重试中保持不变，由服务端 reward_grants 保证幂等。
export interface RewardClaim {
  claimId: Id;
  offerId: string;
  adUnitId: string;
  dramaId?: Id;
  episodeId?: Id;
}

/** ClaimResult 确认实际奖励结算或当前入剧范围已达标，两种结果均结束本地待确认请求。 */
export interface ClaimResult {
  /** entryAdStatus 是本次结算后服务器确认的入剧进度；旧服务端缺省时才补查。 */
  entryAdStatus?: EntryAdStatus;
  /** drama 是逐集结算后完整选集状态；只更新展示，起播仍使用 playback 授权。 */
  drama?: DramaDetail;
  /** nextAd 由服务端决定下一广告；缺省或 null 均停止，不由客户端补查推断。 */
  nextAd?: NextAdPrompt | null;
  /** claimId 对应原广告请求的幂等键，必须与待确认请求一致。 */
  claimId: Id;
  /** status 为入剧已达标时使用 entry_satisfied 确认无需写入，不表示发放新权益。 */
  status: "granted" | "already_granted" | "entry_satisfied";
  /** unlocked 仅表示逐集奖励发放，不表示入剧或 VIP 达标。 */
  unlocked: boolean;
  /** dramaId 是实际结算的来源剧目，VIP 奖励可为空。 */
  dramaId: Id;
  /** episodeId 是逐集奖励的目标集，入剧和 VIP 奖励为空。 */
  episodeId: Id;
  /** rewardType 隔离逐集、VIP 与入剧进度，入剧不发放内容权益。 */
  rewardType: "episode_unlock" | "vip_progress" | "entry_progress";
  /** vipState 仅由 VIP 结算返回当前进度或权益状态。 */
  vipState?: VIPState;
  /** playback 是结算附带的临时播放许可；过期或跨前后台失效时重新验权，不推翻奖励事实。 */
  playback?: PlayResolveResult;
}

/** NextAdPrompt 是服务端结算后给出的提示，不代表目标已解锁。 */
export interface NextAdPrompt {
  /** dramaId 是目标所属短剧。 */
  dramaId: Id;
  /** episodeId 是下一广告目标。 */
  episodeId: Id;
  /** episodeNumber 是展示集号。 */
  episodeNumber: number;
  /** unlockedCount 是服务端确认的已解锁数量。 */
  unlockedCount: number;
  /** totalCount 是目录分集总数。 */
  totalCount: number;
  /** offer 是目标入口及原有提示配置。 */
  offer: AccessOffer;
}

/** BootstrapInput 使用构建包的官方 AppID 建立本次 TikTok 用户身份。 */
export interface BootstrapInput {
  // tiktokAppId 是包内配置的官方 AppID，不能来自启动查询参数。
  tiktokAppId: string;
  // loginCode 是 TikTok 静默登录返回的一次性授权码。
  loginCode?: string;
  // visitorToken 是服务端先前签发的应用范围访问凭据。
  visitorToken?: string;
  // launchQuery 保存 TikTok 启动入口携带的业务参数。
  launchQuery: Record<string, string>;
}

/** MiniDramaApi 定义当前应用消费者读取、播放验权与奖励结算合同。 */
/** ReviewHome 是独立审核首页结果，未命中时客户端继续使用原首页。 */
export interface ReviewHome {
  /** tiktokAppId 用于校验响应所属的构建应用。 */
  tiktokAppId: string;
  /** enabled 由服务端按当前应用和随包版本精确判断。 */
  enabled: boolean;
  /** revision 标识本次主体渠道的审核配置。 */
  revision: number;
  /** dramas 仅包含审核列表内对当前应用可见的线上短剧。 */
  dramas: DramaSummary[];
}

export interface MiniDramaApi {
  /** reviewHome 使用新增接口读取审核首页，不改变原目录、分类、轮播或热播请求。 */
  reviewHome?(tiktokAppId: string): Promise<ReviewHome>;
  /** createSession 通过独立认证入口安装身份，权益刷新不调用此接口。 */
  createSession(input: BootstrapInput): Promise<SessionResult>;
  /** bootstrap 用官方 AppID 和启动凭据建立或恢复身份，成功后返回已安装主体与配置。 */
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
  /** entryAdStatus 携带当前剧目读取所配置范围和模式的广告次数。 */
  entryAdStatus(dramaId?: Id): Promise<EntryAdStatus>;
  /** recordAdShow 幂等保存通用展示事实，不申请权益。 */
  recordAdShow(show: AdShow): Promise<AdShowConfirmation>;
  /** adShowStatus 按场景和可选内容读取每日展示，无需入剧或奖励规则。 */
  adShowStatus(scene: string, dramaId?: Id, episodeId?: Id): Promise<AdShowStatus>;
  /** home 读取已认证应用的首页目录摘要，不返回播放授权。 */
  home(): Promise<HomePayload>;
  /** discover 按筛选条件及游标读取当前应用可见目录，返回当前页和后续游标。 */
  discover(input?: DiscoveryQuery): Promise<DiscoveryPage>;
  /** drama 按内部字符串 ID 读取当前应用可见详情和分集展示状态，不可见或不存在时拒绝。 */
  drama(dramaId: Id): Promise<DramaDetail>;
  /** resolvePlay 按内部剧目及分集字符串 ID 验证当前主体权益，返回播放来源或解锁要求。 */
  resolvePlay(
    dramaId: Id,
    episodeId: Id,
  ): Promise<PlayResolveResult>;
  /** resolvePlayBatch 按输入顺序返回相邻集的权威播放决策。 */
  resolvePlayBatch(
    dramaId: Id,
    episodeIds: Id[],
  ): Promise<PlayResolveResult[]>;
  /** claimReward 提交已完成广告的奖励请求，由服务端按 claimId 幂等结算并返回权益结果。 */
  claimReward(claim: RewardClaim): Promise<ClaimResult>;
  /** claimVIP 在当日广告进度达标后显式领取 VIP 权益；重复领取返回当前有效状态。 */
  claimVIP(): Promise<VIPState>;
  /** unlocks 返回当前主体的有效解锁记录，不包含本机观看进度。 */
  unlocks(): Promise<UnlockRecord[]>;
}

/** HomeRankingCategory 只保存非空分类的身份与展示名称，不附带全部剧目。 */
export interface HomeRankingCategory {
  /** tagId 是官方字符串标签标识，不随译名变化。 */
  tagId: string;
  /** name 优先使用维护的英文名。 */
  name: string;
}

/** HomeRankingPage 是一个分类的一页剧目，分页期间始终携带所属分类身份。 */
export interface HomeRankingPage extends HomeRankingCategory {
  /** dramas 按后台排名顺序返回当前页可展示的短剧。 */
  dramas: DramaSummary[];
  /** nextCursor 为空或省略时表示已到末页。 */
  nextCursor?: string;
}

/** CategoryRankingSection 仅兼容旧版完整分类榜及已有展示快照。 */
export interface CategoryRankingSection extends HomeRankingCategory {
  /** dramas 保留后台排名顺序，仅含当前可展示的短剧。 */
  dramas: DramaSummary[];
}

/** HomeSections 是当前应用的人工推荐和分类榜单，不包含播放凭据。 */
export interface HomeSections {
  /** rankings 兼容尚未提供分类榜单的旧服务端。 */
  rankings?: CategoryRankingSection[];
  /** carousel 按运营配置顺序展示，默认使用短剧线上封面。 */
  carousel: DramaSummary[];
  /** hot 是后台人工配置顺序中的可见短剧，空配置不自动补位。 */
  hot: DramaSummary[];
}
