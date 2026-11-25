/** TikTokError 仅声明官方错误信息；扩展数据不得直接写入日志。 */
export interface TikTokError {
  /** error_code 是平台错误码，不替代错误详情。 */
  error_code?: number;
  /** error_msg 是诊断消息，对用户展示前须进行统一映射。 */
  error_msg?: string;
  /** error_extra 是平台扩展数据，不做完整序列化或输出。 */
  error_extra?: Record<string, unknown>;
}

/** RewardedAdCloseResult 只在明确 true 时证明 SDK 报告完整观看。 */
export interface RewardedAdCloseResult {
  /** isEnded 缺失或 false 均按未完整观看处理。 */
  isEnded?: boolean;
}

/** RewardedVideoAd 约束单次激励广告的展示和监听生命周期。 */
export interface RewardedVideoAd {
  /** show 的 Promise 成功表示展示，不表示完整观看；同一实例只能调用一次。 */
  show(): Promise<void>;
  /** onClose 注册本次关闭回调，只有 isEnded 为 true 才能进入领奖。 */
  onClose(listener: (result: RewardedAdCloseResult) => void): void;
  /** offClose 用同一函数引用解绑；旧 SDK 可能不提供。 */
  offClose?(listener: (result: RewardedAdCloseResult) => void): void;
  /** onError 注册加载或展示失败回调，不直接输出整个错误对象。 */
  onError(listener: (error: unknown) => void): void;
  /** offError 用同一函数引用解绑，失败不应阻止其他清理。 */
  offError?(listener: (error: unknown) => void): void;
}

/** TikTokLoginResult 兼容 SDK 和 CLI 的一次性换码响应，禁止记录 code。 */
export interface TikTokLoginResult {
  /** code 是直接返回的一次性授权码。 */
  code?: string;
  /** authResponse 是 CLI 回调协议使用的授权包装。 */
  authResponse?: {
    /** code 同样是一次性授权码，不能作为业务登录凭证持久化。 */
    code?: string;
  };
}

/** TikTokLoginOptions 描述对象形式的登录回调，不申请头像等资料权限。 */
export interface TikTokLoginOptions {
  /** success 将一次性 code 交给后端换码。 */
  success(result: TikTokLoginResult): void;
  /** fail 记录脱敏消息并保留平台故障分类，不降级匿名发奖。 */
  fail(result: { error?: TikTokError }): void;
  /** complete 只表示调用结束，不能代替 success。 */
  complete?(): void;
}

/** TikTokLoginCallback 兼容 CLI 的函数形式回调，成功仍须检查 code。 */
export type TikTokLoginCallback = (result: TikTokLoginResult) => void;

export interface TikTokSystemInfo {
  /** platform 是官方公开操作系统分类，不用完整 UA 替代。 */
  platform?: string;
  language?: string;
  // version 是 TikTok 客户端公开系统信息，不用于建立另一条播放路径。
  version?: string;
}

export interface TikTokSystemInfoOptions {
  success(result: TikTokSystemInfo): void;
  fail?(result: { error?: TikTokError }): void;
  complete?(): void;
}

export interface TikTokSystemAPI {
  canIUse?(capability: string): boolean;
  getSystemInfoSync?(): TikTokSystemInfo;
  getSystemInfo?(options: TikTokSystemInfoOptions): void;
}

export interface TikTokCaptureResult {
  isSuccess?: boolean;
}

export interface TikTokShareOptions {
  title: string;
  desc?: string;
  imageUrl?: string;
  query?: Record<string, string>;
}

export interface TikTokShareResult {
  is_success?: boolean;
  error?: TikTokError;
}

export type TikTokShareListener = () => void;

// TikTokPlayerKernel 是官方 Player 就绪后暴露的最小播放控制面。
export interface TikTokPlayerKernel {
  /** video 是官方内核现有媒体元素，仅用于观察实际帧，不自行创建播放器。 */
  video?: HTMLVideoElement;
  /** media 是部分 Minis 版本提供的现有媒体元素。 */
  media?: HTMLVideoElement;
  // currentTime 是当前播放位置，单位为秒。
  currentTime?: number;
  // duration 是当前媒体总时长，单位为秒。
  duration?: number;
  // paused 表示当前是否处于暂停状态。
  paused?: boolean;
  // ended 表示当前剧集是否已播放完成。
  ended?: boolean;
  muted?: boolean;
  readyState?: number;
  buffered?: TimeRanges;
  // playbackRate 是当前播放倍速。
  playbackRate?: number;
  // play 请求开始或继续播放。
  play(): Promise<void> | void;
  // pause 暂停当前播放。
  pause(): void;
  // seek 将播放位置移动到指定秒数。
  seek?(seconds: number): void;
}

/** TikTokVePlayerOptions 是两种 SDK 通道共用的初始化合同，专属字段由对应适配器提供。 */
export interface TikTokVePlayerOptions {
  /** 直连正片的起播时间，单位为秒。 */
  startTime?: number;
  /** vodLogOpts 将独立 SDK 的质量日志归属到当前域名对应的 VOD 应用。 */
  vodLogOpts?: {
    /** line_app_id 只在 SDK 要求整数的参数边界转换，不作为业务应用标识。 */
    line_app_id: number;
    /** tag 标识独立 Mini 播放场景，不包含观众身份或凭据。 */
    tag: string;
  };
  /** onGetMediaInfo 仅提取媒体缓存命中信息，不记录完整媒资响应。 */
  onGetMediaInfo?: (data: { fromCache?: boolean }) => void;
  /** defaultDefinition 与预加载保持相同清晰度，复用官方缓存。 */
  defaultDefinition?: "720p";
  /** retryCount 是官方媒体请求的有限重试次数。 */
  retryCount?: number;
  /** enableDegradeMuteAutoplay 在容器限制有声自动播放时使用官方静音降级。 */
  enableDegradeMuteAutoplay?: boolean;
  /** controls 使用官方底部控制区。 */
  controls?: { mode: "bottom" };
  /** getVideoByToken 配置媒体信息查询，授权方式由应用播放通道决定。 */
  getVideoByToken?: {
    /** playAuthToken 仅用于独立 SDK，官方通道由宿主完成授权且不接收此字段。 */
    playAuthToken?: string;
    /** needPoster 要求官方 Player 使用当前 VID 在 BytePlus 中的视频封面。 */
    needPoster?: boolean;
  };
  /** enableMp4MSE 在支持 MSE/MMS 的容器启用官方字节预加载。 */
  enableMp4MSE?: boolean;
  // root 是 React 页面为官方 Player 预留的唯一容器。
  root?: HTMLElement;
  // vid 是 BytePlus VOD 媒资标识。
  vid: string;
  // albumId 是 TikTok 审核通过的 Album 标识。
  albumId?: string;
  // episodeId 是 TikTok 审核通过的 Episode 标识。
  episodeId?: string;
  // lang 是 Player 内置控件的语言。
  lang?: string;
  // autoSubtitle 固定关闭官方媒资字幕解析。
  autoSubtitle?: false;
  // autoplay 请求容器就绪后自动播放。
  autoplay?: boolean;
  // playsinline 保持 TikTok WebView 内联播放。
  playsinline?: boolean;
  // videoFillMode 让竖屏剧集按宽度填充。
  videoFillMode?: "fillWidth";
  // closeVideoClick 关闭官方视频区域单击切换，由业务层实现两段式显示与暂停。
  closeVideoClick?: boolean;
  // closeVideoDblclick 禁止双击切换播放状态。
  closeVideoDblclick?: boolean;
  // ignores 声明沉浸短剧不需要的官方插件。
  ignores?: string[];
  // commonStyle 配置官方 Player 通用样式。
  commonStyle?: Record<string, unknown>;
  // mobile 配置官方 Player 移动端表现。
  mobile?: Record<string, unknown>;
  // sdkErrorPlugin 配置官方错误插件的显示方式。
  sdkErrorPlugin?: Record<string, unknown>;
  // start 配置官方 Player 的启动动画和暂停指示。
  start?: Record<string, unknown>;
}

// TikTokVePlayerInstance 是 Player SDK 实例在本系统中使用的最小合同。
export interface TikTokVePlayerInstance {
  /** preLoadData 提供实际参与起播的字节数量与时长。 */
  preLoadData?: { hit?: number; duration?: number; length?: number };
  // player 是 READY 等事件后可用的播放内核。
  player?: TikTokPlayerKernel;
  // on 订阅官方 Player 事件。
  on(event: string, listener: (payload?: unknown) => void): void;
  // off 解除官方 Player 事件订阅。
  off?(event: string, listener: (payload?: unknown) => void): void;
  // playNext 按官方公开合同在同一实例中切换到下一个已授权剧集。
  playNext(options: TikTokVePlayerOptions): Promise<unknown>;
  // destroy 释放 Player 实例和其事件资源。
  destroy(): void;
}

/** TikTokVePlayerEventName 收敛共用内核订阅的 SDK 事件，媒体就绪与实例创建分开处理。 */
export type TikTokVePlayerEventName =
  | "READY"
  | "COMPLETE"
  | "DURATION_CHANGE"
  | "CANPLAY"
  | "LOAD_START"
  | "LOADED_META_DATA"
  | "LOADED_DATA"
  | "PLAY"
  | "PAUSE"
  | "ENDED"
  | "TIME_UPDATE"
  | "ERROR"
  | "PLAYING"
  | "WAITING"
  | "STALLED"
  | "SEEKING"
  | "SEEKED"
  | "SOURCE_ERROR"
  | "SOURCE_SUCCESS"
  | "TOKEN_EXPIRED"
  | "GET_PLAY_URL_ERR"
  | "LICENSE_STATUS_WARNING"
  | "UMD_LOAD_FAIL"
  | "URL_NULL"
  | "AUTOPLAY_PREVENTED"
  | "AUTOPLAY_FAILED"
  | "LONG_WAITING"
  | "OFTEN_WAITING"
  | "PLAY_NEXT_START"
  | "PLAY_NEXT_END"
  | "PRELOAD_INFO";

// TikTokVePlayerConstructor 包含官方 Player 构造器与事件常量。
export interface TikTokVePlayerConstructor {
  // new 为唯一容器创建官方 Player 实例。
  new(options: TikTokVePlayerOptions): TikTokVePlayerInstance;
  /** prefetchMediaInfo 只预请求已授权剧集的媒体信息，不下载字节。 */
  prefetchMediaInfo?(sources: TikTokVePlayerOptions[]): Promise<{ status: string; error?: { message?: string } }[]>;
  /** prepare 初始化官方 MP4 预加载模块。 */
  prepare?(options: { strategies: { preload: true | { preloadMaxCacheCount: number } } }): Promise<void>;
  /** setPreloadScene 切换首页手动与播放页自动预加载。 */
  setPreloadScene?(scene: number, options?: { preloadTime: number; prevCount?: number; nextCount?: number }): Promise<void> | void;
  /** setPreloadList 设置有权限的有序候选列表。 */
  setPreloadList?(sources: TikTokVePlayerOptions[]): Promise<void>;
  /** setMediaInfoCacheConfig 仅开启内存媒体信息缓存。 */
  setMediaInfoCacheConfig?(options: { enable: boolean; cacheType: "memory" }): void;
  /** clearMediaInfoCache 换主体时释放官方媒体信息。 */
  clearMediaInfoCache?(): void;
  /** preloader 提供页面及主体变化时的任务清理能力。 */
  preloader?: {
    /** clearPreloadList 清空待调度候选，保留已下载字节。 */
    clearPreloadList?(): void;
    /** removeAllPreloadTask 中断当前下载并取消待执行任务。 */
    removeAllPreloadTask?(): void;
    /** removeAll 清除已下载字节，换主体或权益失效时使用。 */
    removeAll?(): void;
  };
  // Events 是官方 SDK 发布的事件常量集合。
  Events?: Partial<Record<TikTokVePlayerEventName, string>>;
}

/** TikTokMinisSDK 描述业务可调用的官方容器能力，版本支持由 canIUse 判断。 */
export interface TikTokMinisSDK extends TikTokSystemAPI {
  /** disableCapture 在 Mini 运行期间禁止系统录屏；页面卸载时必须调用 enableCapture 恢复。 */
  disableCapture?(callback: (result: TikTokCaptureResult) => void): void;
  /** enableCapture 恢复当前页面关闭前的系统录屏能力。 */
  enableCapture?(callback: (result: TikTokCaptureResult) => void): void;
  // reportEvent 回传官方定义的业务事件，callback 只反馈上报结果。
  reportEvent?(options: { eventName: string; params: Record<string, string | number | null>; callback: (result: { isSuccess: boolean }) => void }): void;
  /** init 以当前应用的公开 ClientKey 初始化 SDK，必须先于其他能力调用。 */
  init(options: { clientKey: string }): void;
  /** canIUse 检测当前客户端是否支持指定官方能力，不能代替调用结果校验。 */
  canIUse?(capability: string): boolean;
  /** login 获取一次性授权码，交由服务端换取当前观众身份。 */
  login(options: TikTokLoginOptions | TikTokLoginCallback): void;
  /** createRewardedVideoAd 使用当前应用已激活的广告位创建单次激励实例。 */
  createRewardedVideoAd(options: { adUnitId: string }): RewardedVideoAd;
  // getPlayer 只在 SDK init 完成后调用，生产固定使用 byteplus 通道。
  getPlayer?(channel: "byteplus"): Promise<TikTokVePlayerConstructor>;
  /** share 提交当前可见内容的官方分享信息，回调只说明分享调用结果。 */
  share?(
    callback: (result: TikTokShareResult) => void,
    options: TikTokShareOptions,
  ): void;
  /** on 返回平台监听标识；调用者必须保留它供清理使用。 */
  on?(event: string, listener: TikTokShareListener): string;
  /** off 按平台返回的 callbackId 解绑。 */
  off?(event: string, callbackId: string): boolean;
  /** createInterstitialAd 创建单次普通插屏，不承担发奖语义。 */
  createInterstitialAd?(options: { adUnitId: string }): RewardedVideoAd;
  /** getMenuButtonBoundingClientRect 返回 custom 导航的物理像素坐标。 */
  getMenuButtonBoundingClientRect?(): { top: number; bottom: number; left: number; width: number; height: number; right: number };
  /** getDeviceInfo 提供容器底部安全距离。 */
  getDeviceInfo?(): { bottomHeight?: number };
  /** setNavigationBarColor 设置状态栏和胶囊前景，回调失败仅影响外观。 */
  setNavigationBarColor?(options: { frontColor: string; backgroundColor: string }, callback: (result: TikTokShareResult) => void): void;
  /** game 仅提供现有系统能力入口，不替代短剧专用广告 API。 */
  game?: TikTokSystemAPI;
}
