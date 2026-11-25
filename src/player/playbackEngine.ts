import type { TimedValue } from "../domain/serverTime";

// PlaybackSource 保存固定 provider 的服务端授权源，由各自适配器严格校验。
// 禁止在此处增加 DirectUrl、MP4 或自定义视频元素回退。
export interface PlaybackSource extends TimedValue {
  /** provider 由启动配置确定，历史官方描述符省略时仍为官方。 */
  provider?: "tiktok_minis" | "byteplus_web";
  /** playAuthToken 只在内存保留，直连播放使用。 */
  playAuthToken?: string;
  /** expiresAt 限制相邻集缓存与失败重试。 */
  expiresAt?: string;
  /** autoplay 为 false 时仅准备已授权媒体；显式 play 才开始播放，默认保持原自动播放行为。 */
  autoplay?: boolean;
  /** 直连片段换成已授权正片时，从广告前的位置续播。 */
  startTime?: number;
  // channel 限定官方 Player 的媒资通道。
  channel: "byteplus";
  // albumId 对应 TikTok 官方 Album 标识。
  albumId?: string;
  // episodeId 对应 TikTok 官方 Episode 标识。
  episodeId?: string;
  // vid 对应 BytePlus VOD 媒资标识。
  vid: string;
  // posterUrl 是首帧前的过渡封面。
  posterUrl?: string;
  // title 是业务信息层展示的剧集名称。
  title?: string;
  // episodeNumber 是业务信息层展示的集数。
  episodeNumber?: number;
  // durationSeconds 是首次时长更新前的预估时长。
  durationSeconds?: number;
}

// PlaybackSnapshot 是当前播放内核的状态快照，不作为权益依据。
export interface PlaybackSnapshot {
  // 当前播放位置，单位为秒。
  currentTime: number;
  // 媒体总时长，单位为秒。
  duration: number;
  // 是否处于暂停状态。
  paused: boolean;
  // 是否已播放结束。
  ended: boolean;
  /** muted 表示宿主自动播放策略是否把当前播放降级为静音。 */
  muted?: boolean;
  /** readyState 直接反映当前帧与后续数据是否可用。 */
  readyState?: number;
}

// PlaybackCallbacks 将 SDK 播放事实和脱敏故障传递给共用页面。
export interface PlaybackCallbacks {
  // 实例或媒体就绪发生变化，可重复通知；恢复进度仍须确认实际时长及定位结果。
  onReady?(): void;
  // 官方确认当前来源首帧可显示时携带 vid，不要求正在播放或时间大于零。
  onFirstFrame?(vid: string): void;
  // 实际开始或恢复播放时通知；不能由仅表示播放请求的 PLAY 触发。
  onPlay?(): void;
  // 官方内核进入或离开缓冲时通知页面保留首图，避免直接暴露黑帧。
  onBufferingChange?(buffering: boolean): void;
  /** seek 完成后通知页面，续播仍须等待 seek 后实际帧再撤首图。 */
  onSeeked?(): void;
  /** 进度条有效横向拖动开始或结束时通知页面暂停并重启无操作计时。 */
  onSeekingChange?(seeking: boolean): void;
  /** 自动播放被阻止或降级静音时展示一次明确的用户操作入口。 */
  onAutoplayBlocked?(muted: boolean): void;
  /** playNext 官方切换阶段用于精确控制切集 UI 与耗时。 */
  onSwitchingChange?(switching: boolean): void;
  /** onSwitchCompleted 仅当前目标的 playNext 成功兑现时通知一次，不等同于首帧。 */
  onSwitchCompleted?(): void;
  // 播放暂停时通知页面。
  onPause?(): void;
  // 当前分集播放结束时通知页面。
  onEnded?(): void;
  // 进度变化时提供内核快照。
  onTimeUpdate?(snapshot: PlaybackSnapshot): void;
  // 传递已在适配器记录诊断的故障，页面负责友好提示。
  onError?(error: unknown): void;
}

// PlaybackEngine 封装播放控制，页面不直接依赖官方 SDK。
export interface PlaybackEngine {
  // 挂载指定来源；异步结果失效时返回 false。
  mount(root: HTMLElement, source: PlaybackSource, callbacks?: PlaybackCallbacks): Promise<boolean>;
  // 通过官方能力切换来源，失败时保留错误传播。
  switchSource(source: PlaybackSource): Promise<void>;
  /** whenInitialMediaLoading 等独立播放器开始加载当前来源，再调度下一集已授权的播放信息。 */
  whenInitialMediaLoading?(currentVid: string, prepareNext: () => void): void;
  // 请求开始或恢复播放，完成不代表已经产生播放画面。
  play(): Promise<void>;
  // 暂停当前播放。
  pause(): void;
  // 定位到非负秒数位置。
  seek(seconds: number): void;
  // 设置官方播放内核的播放倍速。
  setPlaybackRate?(rate: number): void;
  /** 用户明确操作后恢复声音。 */
  setMuted?(muted: boolean): void;
  // 读取当前内核状态。
  snapshot(): PlaybackSnapshot;
  // 释放实例并解绑监听器，使未完成的挂载失效。
  destroy(): void;
}
