/** ClientLogLevel 区分调试、业务结果、预期拒绝和非预期失败。 */
export type ClientLogLevel = "debug" | "info" | "warn" | "error";

// ClientLogFields 是可写入客户端日志的白名单。
// 故意不接受 token、URL、请求体或平台原始错误对象。
export interface ClientLogFields {
  /** tiktokAppId 标明当前包所属应用，不使用 Client Key 或观众凭据关联日志。 */
  tiktokAppId?: string;
  /** provider 区分宿主播放器和独立 BytePlus 播放器。 */
  provider?: string;
  /** sdkAppId 是选中 License 的 BytePlus 应用标识。 */
  sdkAppId?: string;
  /** hostname 只记录页面主机名，不包含启动路径、查询或签名。 */
  hostname?: string;
  /** licenseDomain 是选中 License 声明的域名后缀，不包含许可内容。 */
  licenseDomain?: string;
  /** playerEvent 是 SDK 事件名称，不记录回调原始对象。 */
  playerEvent?: string;
  /** veErrorCode 保留 BytePlus Web SDK 的数值细分错误码。 */
  veErrorCode?: string;
  /** readyState 是现有媒体元素的数据就绪级别。 */
  readyState?: number;
  /** networkState 是现有媒体元素的资源加载状态。 */
  networkState?: number;
  /** mediaErrorCode 是浏览器 MediaError 的数值错误码。 */
  mediaErrorCode?: number;
  /** paused 表示内核当前是否暂停，不能据此判断内容已出画。 */
  paused?: boolean;
  /** muted 区分静音自动播放降级与完全没有播放。 */
  muted?: boolean;
  /** mediaPresent 表示 SDK 是否已经暴露现有媒体元素。 */
  mediaPresent?: boolean;
  /** mediaConnected 表示媒体元素是否仍在页面中，不能单独作为平台拦截结论。 */
  mediaConnected?: boolean;
  /** visibility 记录采样时页面可见状态，区分后台挂起。 */
  visibility?: string;
  /** errorCode 只保留 SDK 白名单中的数值错误码字符串，不接受登录授权 code。 */
  errorCode?: string;
  /** subErrorCode 保留平台数值子错误码，不序列化扩展错误对象。 */
  subErrorCode?: string;
  /** adAttemptId 关联异常调用，不附整段诊断历史。 */
  adAttemptId?: string;
  /** innerErrorCode 独立保留 SDK 内部码。 */
  innerErrorCode?: string;
  /** innerError 是已脱敏的内部错误消息，只用于本地诊断。 */
  innerError?: string;
  /** recovery 标注广告结果未知时需要由宿主关闭并重开容器，不能用本地重拉代替。 */
  recovery?: "reopen_mini";
  /** fromCache 标识媒体信息命中，与视频字节命中分开。 */
  fromCache?: boolean;
  /** hit 表示 SDK 报告的字节预加载命中。 */
  hit?: number;
  /** bytes 为已使用缓存字节量。 */
  bytes?: number;
  /** durationSeconds 为缓存覆盖时长。 */
  durationSeconds?: number;
  /** measurement 区分实际帧回调与估计出画时间。 */
  measurement?: string;
  /** mediaConnectMs 是当前媒体匹配请求公开的连接阶段耗时，零表示本次记录未重新连接。 */
  mediaConnectMs?: number;
  /** mediaResponseWaitMs 是当前媒体匹配请求从发送到首字节的耗时。 */
  mediaResponseWaitMs?: number;
  /** mediaResponseTransferMs 是匹配请求从首字节到完成的耗时，不代表已下载整集。 */
  mediaResponseTransferMs?: number;
  /** mediaRequestDurationMs 是首个匹配并已完成的浏览器媒体请求耗时。 */
  mediaRequestDurationMs?: number;
  /** frameProcessingMs 仅来自原生帧回调，包含该帧解码与相关处理。 */
  frameProcessingMs?: number;
  /** preloadHit 为当前集首帧关联的 SDK 缓存命中。 */
  preloadHit?: number;
  /** preloadBytes 为当前集起播复用字节数。 */
  preloadBytes?: number;
  // flow 标识端到端业务流程。
  flow?: string;
  // stage 标识当前执行阶段或稳定 API 路径。
  stage?: string;
  // outcome 记录 success、failed 或稳定失败分类。
  outcome?: string;
  // dramaId 是系统内部短剧标识。
  dramaId?: string;
  /** tagId 是首页分类的官方字符串标识，用于定位分类分页故障。 */
  tagId?: string;
  // episodeId 是剧集标识，具体含义由事件流程决定。
  episodeId?: string;
  // episodeNumber 是连续广告提示指向的剧集序号，不作为播放授权依据。
  episodeNumber?: number;
  // albumId 是 TikTok 官方 Album 标识。
  albumId?: string;
  // vid 是 BytePlus VOD 媒资标识。
  vid?: string;
  // requestId 是 API 返回的请求关联标识。
  requestId?: string;
  // errorType 只记录错误类型，不记录原始错误内容。
  errorType?: string;
  // error 保留可诊断的错误消息；输出前针对凭据与 URL 脱敏，不接受完整业务对象。
  error?: string;
  // elapsedMs 记录当前阶段耗时。
  elapsedMs?: number;
  // scene 是官方预加载场景：0 为手动、1 为 Feed。
  scene?: 0 | 1;
  // sourceCount 是提交给官方预加载器的候选数量。
  sourceCount?: number;
  // positionSeconds 记录事件发生时的播放位置。
  positionSeconds?: number;
}

// logClientEvent 以稳定事件名和白名单字段记录核心流程，便于真机日志联合排查。
export function logClientEvent(
  level: ClientLogLevel,
  event: string,
  fields: ClientLogFields = {},
): void {
  const record = { event, ...fields, ...(fields.innerError ? { innerError: safeErrorMessage(fields.innerError) } : {}), ...(fields.error ? { error: safeErrorMessage(fields.error) } : {}) };
  // 本地和预览调试页会折叠日志对象；正式包在构建时剔除专项时序输出。
  if ((import.meta.env.DEV || import.meta.env.VITE_MINIS_PREVIEW_BUILD === "1") &&
      typeof window !== "undefined" && new URLSearchParams(window.location.search).get("enableDevMode") === "1" &&
      /^(?:official_playback_(?:mount_started|ready|source_switch_started|source_switch_completed|first_frame)|official_preload_hit|media_preload_(?:update_requested|list_started|list_submitted|info_only)|episode_authorization_ready|direct_(?:player_media_info_ready|media_info_(?:prefetch_(?:started|succeeded)|handoff))|auto_unlock_prompt_dismissed)$/.test(event)) {
    console.info(`PLAYBACK_TIMELINE ${JSON.stringify(record)}`);
  }
  if (level === "error") {
    console.error(record);
    return;
  }
  if (level === "warn") {
    console.warn(record);
    return;
  }
  if (level === "debug") {
    console.debug(record);
    return;
  }
  console.info(record);
}

/** safeErrorMessage 只提取错误消息，定向隐藏 URL 和常见凭据值，避免丢弃实际失败原因。 */
export function safeErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Unknown error";
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    // Cookie 的分号连接多个凭据；未加引号的字段隐藏到行末，不能只遮蔽第一项。
    .replace(/(["']?(?:cookie|set-cookie)["']?[ \t]*[=:][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]*)/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|signature|cookie)|authorization|code|open_?id)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]");
}
