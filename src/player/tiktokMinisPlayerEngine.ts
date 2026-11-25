import { bindProgressGesture } from "./progressGesture";
import { supportsMediaPreload } from "./preload";
import { platformErrorMessage } from "../platform/tiktok/errors";
import { logClientEvent } from "../observability/clientLog";
import { playbackErrorFields, playbackMediaFields, playbackResourceFields } from "./playbackDiagnostics";
import diagnostics from "../config/playbackDiagnostics.json";
import type {
  TikTokVePlayerConstructor,
  TikTokVePlayerInstance,
  TikTokVePlayerOptions,
} from "../platform/tiktok/types";
import type { TikTokMinisPlayerAdapter } from "./tiktokMinisPlayerAdapter";
import type {
  PlaybackCallbacks,
  PlaybackEngine,
  PlaybackSnapshot,
  PlaybackSource,
} from "./playbackEngine";

type BoundListener = { event: string; listener: (payload?: unknown) => void };

const EMPTY_SNAPSHOT: PlaybackSnapshot = {
  currentTime: 0,
  duration: 0,
  paused: true,
  ended: false,
};

// IMMERSIVE_PLAYER_IGNORES 对齐官方沉浸式短剧示例，只保留 progress 和中央 start；
// 页面已有选集与倍速入口，避免官方底栏的其他按钮和业务底栏重叠。
const IMMERSIVE_PLAYER_IGNORES = [
  "moreButtonPlugin",
  "enter",
  "fullscreen",
  "volume",
  "play",
  "pip",
  "replay",
  "playbackrate",
  "miniProgress",
  "sdkDefinitionPlugin",
];

// officialPlayerOptions 只把服务端审核后的标识传入 TikTok 官方 Player。
// 官方 UI 保留短剧需要的播放能力，仅按 TikTok 沉浸式场景收敛不适用插件。
export function officialPlayerOptions(
  source: PlaybackSource,
  root?: HTMLElement,
): TikTokVePlayerOptions {
  validateOfficialSource(source);
  return {
    root,
    onGetMediaInfo: data => logClientEvent("info", "official_media_info_ready", { albumId: source.albumId, episodeId: source.episodeId, fromCache: data.fromCache === true }),
    // 源视频与多清晰度视频都由官方媒体信息选择可用清晰度，不强制依赖 720p 转码。
    retryCount: 3,
    enableDegradeMuteAutoplay: true,
    enableMp4MSE: supportsMediaPreload(),
    vid: source.vid,
    albumId: source.albumId,
    episodeId: source.episodeId,
    lang: "en",
    autoSubtitle: false,
    autoplay: source.autoplay !== false,
    playsinline: true,
    videoFillMode: "fillWidth",
    // 页面接管单击：隐藏态先显示信息，显示态再暂停，避免官方点击处理同时切换播放状态。
    closeVideoClick: true,
    closeVideoDblclick: true,
    controls: { mode: "bottom" },
    // 官方 needPoster 独立于业务封面 URL，请求当前集媒体信息时始终取得播放器封面。
    getVideoByToken: { needPoster: true },
    ignores: [...IMMERSIVE_PLAYER_IGNORES, "Subtitle"],
    commonStyle: {
      playedColor: "#ffffff",
    },
    mobile: {
      gradient: "none",
      // 视频区域不接管横向快进和纵向切集；仅进度条区域按在播位置处理相对拖动。
      gestureX: false,
      gestureY: false,
      closedbClick: true,
      focusVideoClick: true,
    },
    // 官方错误层展示错误状态，刷新动作由 H5 重新做权益校验并获取最新播放描述符。
    sdkErrorPlugin: {
      isNeedRefreshButton: false,
    },
    start: {
      disableAnimate: true,
      isShowPause: true,
    },
  };
}

// SDKPlaybackEngine 共用页面控制和实例生命周期，构造参数与来源校验由各通道适配器注入。
// 本实现不创建 HTML video，也不提供其他播放器回退分支。
export class SDKPlaybackEngine implements PlaybackEngine {
  private instance?: TikTokVePlayerInstance;
  private progressGesture?: ReturnType<typeof bindProgressGesture>;
  private playerConstructor?: TikTokVePlayerConstructor;
  private callbacks: PlaybackCallbacks = {};
  private listeners: BoundListener[] = [];
  private source?: PlaybackSource;
  private generation = 0;
  private switchRevision = 0;
  private switching = false;
  private reportedSwitching = false;
  private switchQueue: Promise<void> = Promise.resolve();
  private sourceStartedAt = 0;
  private sourceReadyReported = false;
  private initialMediaLoading?: { started: boolean; prepareNext?: () => void };
  private firstFrameReported = false;
  private pendingFirstFrame = false;
  private cancelFrame?: () => void;
  private waitingAt?: number;
  private bufferingTimer?: number;
  private buffering?: boolean;
  private playbackActive = false;
  private playRequested = false;
  private startupDiagnosticTimer?: number;
  private observedEvents = new Set<string>();
  private lastPlayerEvent?: string;

  constructor(
    private readonly adapter: TikTokMinisPlayerAdapter,
    private readonly optionsFactory: typeof officialPlayerOptions = officialPlayerOptions,
    private readonly sourceValidator: (source: PlaybackSource) => void = validateOfficialSource,
    // 独立播放适配器可以接续已有的播放信息请求，官方宿主沿用原挂载和切源时序。
    private readonly takePreparedSource?: (source: PlaybackSource) => Promise<void> | undefined,
  ) {}

  // mount 获取官方构造器，在指定容器创建并绑定 Player。
  async mount(
    root: HTMLElement,
    source: PlaybackSource,
    callbacks: PlaybackCallbacks = {},
  ): Promise<boolean> {
    this.destroy();
    const generation = this.generation;
    this.callbacks = callbacks;
    this.validateSource(source);
    this.source = source;
    if (source.provider === "byteplus_web" && source.autoplay !== false) {
      this.initialMediaLoading = { started: false };
    }
    this.playbackActive = false;
    this.sourceStartedAt = performance.now();
    this.sourceReadyReported = false;
    logClientEvent("info", "official_playback_mount_started", this.logFields(source, "create_player", "started"));
    try {
      const constructorReady = this.adapter.getConstructor();
      const handoff = this.takePreparedSource?.(source);
      const playerConstructor = handoff ? (await Promise.all([constructorReady, handoff]))[0] : await constructorReady;
      if (generation !== this.generation) return false;
      logClientEvent("info", "official_playback_constructor_ready", {
        ...this.logFields(source, "constructor", "ready"), elapsedMs: Math.max(0, performance.now() - this.sourceStartedAt),
      });
      this.playerConstructor = playerConstructor;
      const creationStartedAt = performance.now();
      this.instance = new playerConstructor(this.optionsFactory(source, root));
      logClientEvent("info", "official_playback_instance_created", {
        ...this.logFields(source, "create_player", "completed"), elapsedMs: Math.max(0, performance.now() - creationStartedAt),
      });
      this.bindEvents();
      if (source.autoplay !== false) this.observeStartup();
      this.progressGesture = bindProgressGesture(root, () => this.snapshot(), seconds => this.seek(seconds), seeking => this.callbacks.onSeekingChange?.(seeking));
      return true;
    } catch (reason) {
      logClientEvent("error", "official_playback_mount_failed", {
        ...this.logFields(source, "create_player", "failed"),
        ...playbackErrorFields(reason, "Player creation failed"),
      });
      throw reason;
    }
  }

  /** whenInitialMediaLoading 接收业务层已授权的下一集任务；首源加载前仅保留最新任务。 */
  whenInitialMediaLoading(currentVid: string, prepareNext: () => void): void {
    const loading = this.initialMediaLoading;
    if (!loading || this.source?.vid !== currentVid) return;
    loading.prepareNext = prepareNext;
    this.scheduleInitialNextPreparation();
  }

  private scheduleInitialNextPreparation(): void {
    const loading = this.initialMediaLoading;
    const prepareNext = loading?.prepareNext;
    if (!loading?.started || !prepareNext) return;
    // 首集事件先交还 SDK；切源、销毁或替换候选后，已排队的旧任务不得发请求。
    queueMicrotask(() => {
      if (loading !== this.initialMediaLoading || loading.prepareNext !== prepareNext) return;
      loading.prepareNext = undefined;
      try { prepareNext(); }
      catch (reason) {
        logClientEvent("warn", "direct_next_media_info_schedule_failed", playbackErrorFields(reason, "Next episode preparation failed"));
      }
    });
  }

  // switchSource 使用官方 playNext 切集，不重建视频元素。
  async switchSource(source: PlaybackSource): Promise<void> {
    this.clearStartupDiagnostic();
    this.progressGesture?.cancel();
    this.playRequested = false;
    if (!this.instance) throw new Error("Official Player is not mounted");
    this.validateSource(source);
    this.initialMediaLoading = undefined;
    this.cancelFrame?.(); this.cancelFrame = undefined;
    this.waitingAt = undefined;
    this.emitBuffering(false);
    const revision = ++this.switchRevision;
    const generation = this.generation;
    const instance = this.instance;
    this.switching = true;
    this.emitSwitching(true);
    const handoff = this.takePreparedSource?.(source);
    if (handoff) {
      // 等待放在切源队列之外，快速再切一集时，新目标无需等待上一集的播放信息。
      await handoff;
      if (generation !== this.generation || revision !== this.switchRevision) return;
    }
    const pending = this.switchQueue.catch(() => undefined).then(async () => {
      if (generation !== this.generation || revision !== this.switchRevision) return;
      this.source = source;
      this.playbackActive = false;
      this.sourceStartedAt = performance.now();
      this.sourceReadyReported = false;
      this.firstFrameReported = false;
      this.pendingFirstFrame = false;
      this.observedEvents.clear();
      this.lastPlayerEvent = undefined;
      // 每次真正进入切源时换绑事件，已经排队的旧监听不能归属到新媒体。
      for (const binding of this.listeners) instance.off?.(binding.event, binding.listener);
      this.listeners = [];
      this.bindEvents();
      if (source.autoplay !== false) this.observeStartup();
      const previousMuted = instance.player?.media?.muted ?? instance.player?.muted;
      try {
        logClientEvent("info", "official_playback_source_switch_started", this.logFields(source, "play_next", "started"));
        // 官方 Feed 场景由 playNext 在同一实例内完成切换并消费预加载缓存。
        // 切换前不额外暂停，也不传未公开的重置参数，避免重复经历停播、重置和起播。
        await instance.playNext(this.optionsFactory(source));
        logClientEvent("info", "official_playback_source_switch_completed", {
          ...this.logFields(source, "play_next", "completed"),
          elapsedMs: Math.max(0, performance.now() - this.sourceStartedAt),
        });
        if (typeof previousMuted === "boolean" && instance.player) {
          instance.player.muted = previousMuted;
          if (instance.player.media) {
            instance.player.media.muted = previousMuted;
            instance.player.media.defaultMuted = previousMuted;
          }
        }
      } catch (reason) {
        this.clearStartupDiagnostic();
        logClientEvent("error", "official_playback_source_switch_failed", {
          ...this.logFields(source, "play_next", "failed"), ...playbackErrorFields(reason, "Player source switch failed"),
        });
        if (generation === this.generation && revision === this.switchRevision) throw reason;
      } finally {
        if (generation === this.generation && revision === this.switchRevision) {
          this.switching = false;
          this.emitSwitching(false);
        }
      }
      if (generation !== this.generation || revision !== this.switchRevision) return;
      this.callbacks.onSwitchCompleted?.();
      // 先恢复本地位置；不能等 play() 出画后才 seek，否则先播放开头再跳历史位置。
      this.callbacks.onReady?.();
      // playNext 兑现后才允许当前事件归属于新媒体；切源期间的旧 TIME_UPDATE/PLAYING 一律不使用。
      this.pendingFirstFrame = true;
      this.playbackActive = instance.player?.paused === false;
      this.reportFirstFrame("play_next_complete", false);
      if (!this.snapshot().paused) {
        this.callbacks.onPlay?.();
      } else if (source.autoplay !== false) {
        // playNext 自带 autoplay；仅补偿仍暂停的内核，且不让播放 Promise 阻塞切源收尾。
        void this.play().catch((reason) => {
          if (generation !== this.generation || revision !== this.switchRevision) return;
          logClientEvent("warn", "official_switch_resume_failed", { error: platformErrorMessage(reason, "Official Player resume failed") });
          this.callbacks.onAutoplayBlocked?.(instance.player?.muted === true);
        });
      }
    });
    this.switchQueue = pending;
    return pending;
  }

  // play 通过官方播放内核继续播放。
  async play(): Promise<void> {
    this.observeStartup();
    if (!this.instance?.player) {
      this.playRequested = true;
      return;
    }
    this.playRequested = false;
    try {
      await this.instance.player.play();
    } catch (reason) {
      this.clearStartupDiagnostic();
      // DOMException 不保证继承当前页面的 Error；用户手势限制与主动取消按预期中断分级。
      const name = reason && typeof reason === "object" ? (reason as { name?: unknown }).name : undefined;
      logClientEvent(name === "NotAllowedError" || name === "AbortError" ? "warn" : "error", "player_play_request_failed", {
        ...this.source && this.logFields(this.source, "play", "failed"),
        ...playbackMediaFields(this.instance), ...playbackErrorFields(reason, "Player play request failed"),
      });
      throw reason;
    }
  }

  // pause 通过官方播放内核暂停播放。
  pause(): void {
    this.clearStartupDiagnostic();
    this.playRequested = false;
    this.instance?.player?.pause();
  }

  // seek 将官方播放内核移动到指定位置。
  seek(seconds: number): void {
    this.cancelFrame?.(); this.cancelFrame = undefined;
    this.firstFrameReported = false;
    this.pendingFirstFrame = true;
    this.sourceStartedAt = performance.now();
    this.instance?.player?.seek?.(Math.max(0, seconds));
  }

  // setPlaybackRate 使用官方播放内核切换倍速。
  setPlaybackRate(rate: number): void {
    const player = this.instance?.player;
    if (player) player.playbackRate = rate;
  }

  // setMuted 通过 SDK 内核更新声音状态，供用户解除自动播放静音降级。
  setMuted(muted: boolean): void {
    const player = this.instance?.player;
    if (player) player.muted = muted;
  }

  // snapshot 返回当前播放内核的可观测状态。
  snapshot(): PlaybackSnapshot {
    const player = this.instance?.player;
    if (!player) return EMPTY_SNAPSHOT;
    return {
      currentTime: Number(player.currentTime || 0),
      duration: Number(player.duration || 0),
      paused: typeof player.paused === "boolean" ? player.paused : !this.playbackActive,
      ended: player.ended === true,
      muted: player.muted === true,
      readyState: Number(player.readyState || player.video?.readyState || 0),
    };
  }

  // destroy 解除事件并释放官方 Player 实例。
  destroy(): void {
    this.clearStartupDiagnostic();
    this.observedEvents.clear();
    this.lastPlayerEvent = undefined;
    this.progressGesture?.destroy();
    this.progressGesture = undefined;
    this.playRequested = false;
    this.cancelFrame?.(); this.cancelFrame = undefined;
    this.waitingAt = undefined;
    window.clearTimeout(this.bufferingTimer);
    this.bufferingTimer = undefined;
    this.buffering = undefined;
    this.playbackActive = false;
    this.generation += 1;
    this.switchRevision += 1;
    this.switching = false;
    this.reportedSwitching = false;
    this.switchQueue = Promise.resolve();
    if (this.instance) {
      for (const binding of this.listeners) {
        this.instance.off?.(binding.event, binding.listener);
      }
      this.instance.destroy();
    }
    this.instance = undefined;
    this.playerConstructor = undefined;
    this.callbacks = {};
    this.listeners = [];
    this.source = undefined;
    this.initialMediaLoading = undefined;
    this.sourceReadyReported = false;
    this.firstFrameReported = false;
    this.pendingFirstFrame = false;
  }

  private validateSource(source: PlaybackSource): void {
    this.sourceValidator(source);
  }

  private bindEvents(): void {
    const events = this.playerConstructor?.Events;
    const ready = () => {
      if (!this.sourceReadyReported && this.source) {
        this.sourceReadyReported = true;
        logClientEvent("info", "official_playback_ready", {
          ...this.logFields(this.source, "ready", "success"),
          elapsedMs: Math.max(0, performance.now() - this.sourceStartedAt),
        });
      }
      this.callbacks.onReady?.();
      if (this.playRequested && this.instance?.player) {
        const generation = this.generation;
        const revision = this.switchRevision;
        void this.play().catch(reason => {
          logClientEvent("warn", "official_prepared_resume_failed", { error: platformErrorMessage(reason, "Official Player resume failed") });
          if (generation !== this.generation || revision !== this.switchRevision) return;
          this.callbacks.onAutoplayBlocked?.(this.instance?.player?.muted === true);
        });
      }
    };
    this.bind(events?.READY || "ready", ready);
    this.bind(events?.COMPLETE || "complete", ready);
    if (this.source?.provider === "byteplus_web") {
      // 独立 SDK 的实例就绪早于媒体时长；暂停恢复也通过媒体事件再次确认，不依赖起播后的时间推进。
      this.bind(events?.DURATION_CHANGE || "durationchange", ready);
      this.bind(events?.CANPLAY || "canplay", ready);
    }
    this.bind(events?.PAUSE || "pause", () => { this.playbackActive = false; this.callbacks.onPause?.(); });
    this.bind(events?.ENDED || "ended", () => { this.playbackActive = false; this.callbacks.onEnded?.(); });
    this.bind(events?.TIME_UPDATE || "timeupdate", (payload) => {
      if (this.switching) return;
      const current = this.snapshot();
      const data = payload && typeof payload === "object" ? payload as { currentTime?: unknown; duration?: unknown } : undefined;
      const snapshot = {
        ...current,
        currentTime: Number.isFinite(Number(data?.currentTime)) ? Number(data?.currentTime) : current.currentTime,
        duration: Number.isFinite(Number(data?.duration)) && Number(data?.duration) > 0 ? Number(data?.duration) : current.duration,
      };
      // 时间推进触发帧观察；可用时等待实际帧回调，否则明确标记估计值。
      if (!snapshot.paused && snapshot.currentTime > 0) {
        window.clearTimeout(this.bufferingTimer); this.bufferingTimer = undefined;
        this.emitBuffering(false);
        this.pendingFirstFrame = true;
        this.reportFirstFrame("time_update", true);
      }
      this.callbacks.onTimeUpdate?.(snapshot);
    }, true);
    // PLAY 只表示请求播放；PLAYING 才代表新媒体已开始输出，可结束页面切集态。
    const beginBuffering = () => {
      this.waitingAt ??= performance.now();
      window.clearTimeout(this.bufferingTimer);
      if (!this.firstFrameReported) this.emitBuffering(true);
      else this.bufferingTimer = window.setTimeout(() => {
        this.bufferingTimer = undefined;
        this.emitBuffering(true);
      }, 180);
    };
    this.bind(events?.WAITING || "waiting", beginBuffering);
    this.bind(events?.STALLED || "stalled", beginBuffering);
    this.bind(events?.SEEKING || "seeking", () => { this.pendingFirstFrame = true; });
    this.bind(events?.SEEKED || "seeked", () => {
      // 定位前的帧可能已被页面拒收；完成后必须重新观察，不能等下一次时间更新解锁画面。
      this.cancelFrame?.(); this.cancelFrame = undefined;
      this.firstFrameReported = false;
      this.callbacks.onSeeked?.();
      this.pendingFirstFrame = true;
      this.reportFirstFrame("seeked_time_update", false);
    });
    this.bind(events?.PLAY_NEXT_START || "play_next_start", () => this.emitSwitching(true), true);
    this.bind(events?.PLAY_NEXT_END || "play_next_end", () => this.emitSwitching(false), true);
    this.bind(events?.PRELOAD_INFO || "preload_info", (payload) => {
      const data = this.instance?.preLoadData;
      const eventData = payload && typeof payload === "object" ? payload as { byteLength?: unknown } : undefined;
      const eventBytes = Number(eventData?.byteLength);
      logClientEvent("info", "official_preload_hit", {
        ...this.source && this.logFields(this.source, "preload", "observed"),
        hit: data?.hit,
        bytes: Number.isFinite(eventBytes) && eventBytes > 0 ? eventBytes : data?.length,
        durationSeconds: data?.duration,
      });
    }, true);
    this.bind(events?.PLAYING || "playing", () => {
      if (this.switching) return;
      this.playbackActive = true;
      window.clearTimeout(this.bufferingTimer); this.bufferingTimer = undefined;
      const recovering = this.waitingAt !== undefined;
      if (this.waitingAt !== undefined) {
        logClientEvent("info", "official_buffer_recovered", { episodeId: this.source?.episodeId, elapsedMs: performance.now() - this.waitingAt });
        this.waitingAt = undefined;
      }
      // 缓冲恢复时 PLAYING 仍可能早于合成画面；等后续有效时间更新再撤首图。
      if (!recovering) this.emitBuffering(false);
      this.pendingFirstFrame = true;
      // PLAYING 可能早于合成首帧；有原生帧回调时等待它，否则由首个有效 TIME_UPDATE 收口。
      this.reportFirstFrame("playing_estimate", false);
      this.callbacks.onPlay?.();
      if (this.instance?.player?.muted === true) this.callbacks.onAutoplayBlocked?.(true);
    }, true);
    const playbackFailed = (reason?: unknown) => {
      this.clearStartupDiagnostic();
      const source = this.source;
      if (source) {
        logClientEvent("error", "official_playback_error", {
          ...this.logFields(source, "player_event", "failed"),
          ...playbackMediaFields(this.instance),
          ...playbackErrorFields(reason, "Player playback failed"),
          playerEvent: this.lastPlayerEvent,
        });
      }
      this.emitBuffering(false);
      this.callbacks.onError?.(reason);
    };
    this.bind(events?.ERROR || "error", playbackFailed);
    this.bind(events?.SOURCE_ERROR || "source_error", playbackFailed);
    this.bind(events?.TOKEN_EXPIRED || "playAuthToken_expired", playbackFailed);
    // SDK 仍可能自行重试；保留一次未出画采样，不把非终态事件当作已经结束启动。
    for (const event of [events?.GET_PLAY_URL_ERR || "get_play_url_err", events?.UMD_LOAD_FAIL || "umd_load_fail", events?.URL_NULL || "urlNull"]) {
      this.bind(event, reason => {
        logClientEvent("error", "player_source_request_failed", {
          ...this.source && this.logFields(this.source, "source_request", "failed"),
          ...playbackMediaFields(this.instance), ...playbackErrorFields(reason, "Player source request failed"), playerEvent: event,
        });
      }, true);
    }
    this.bind(events?.LICENSE_STATUS_WARNING || "license_status_warning", reason => logClientEvent("warn", "player_license_warning", {
      ...playbackErrorFields(reason, "Player license status warning"), vid: this.source?.vid,
    }));
    this.bind(events?.LOAD_START || "loadstart", () => {
      if (!this.initialMediaLoading || this.initialMediaLoading.started) return;
      // LOAD_START 只说明 SDK 已开始加载当前来源，不用于撤封面或确认播放。
      this.initialMediaLoading.started = true;
      this.scheduleInitialNextPreparation();
    }, true);
    for (const event of [events?.LOADED_META_DATA || "loadedmetadata", events?.LOADED_DATA || "loadeddata", events?.SOURCE_SUCCESS || "source_success"]) {
      this.bind(event, () => undefined, true);
    }
    const autoplayBlocked = (reason?: unknown) => {
      this.clearStartupDiagnostic();
      logClientEvent("warn", "player_autoplay_blocked", {
        ...playbackMediaFields(this.instance), ...playbackErrorFields(reason, "Player autoplay was prevented"),
        playerEvent: this.lastPlayerEvent, vid: this.source?.vid,
      });
      this.callbacks.onAutoplayBlocked?.(this.instance?.player?.muted === true);
    };
    this.bind(events?.AUTOPLAY_PREVENTED || "autoplay_was_prevented", autoplayBlocked, true);
    this.bind(events?.AUTOPLAY_FAILED || "autoplay_failed", autoplayBlocked, true);
    this.bind(events?.LONG_WAITING || "long_waiting", () => logClientEvent("warn", "official_long_waiting", { episodeId: this.source?.episodeId }), true);
    this.bind(events?.OFTEN_WAITING || "often_waiting", () => logClientEvent("warn", "official_often_waiting", { episodeId: this.source?.episodeId }), true);
  }

  private bind(event: string, listener: (payload?: unknown) => void, duringSwitch = false): void {
    if (!this.instance) return;
    const generation = this.generation;
    const revision = this.switchRevision;
    const guarded = (payload?: unknown) => {
      if (generation === this.generation && revision === this.switchRevision && (!this.switching || duringSwitch)) {
        if (!/^(?:timeupdate|preload_info)$/.test(event)) {
          this.lastPlayerEvent = event;
          // 每次授权源只采样同类事件一次，避免缓冲与暂停频繁刷日志。
          if (!this.observedEvents.has(event)) {
            this.observedEvents.add(event);
            logClientEvent("info", "player_media_event", {
              ...this.source && this.logFields(this.source, "media_event", "observed"),
              ...playbackMediaFields(this.instance), playerEvent: event,
              elapsedMs: Math.max(0, performance.now() - this.sourceStartedAt),
            });
          }
        }
        listener(payload);
      }
    };
    this.instance.on(event, guarded);
    this.listeners.push({ event, listener: guarded });
  }

  /** observeStartup 在请求播放后仍未出画时采样一次，不中止播放或改变权益与恢复结果。 */
  private observeStartup(): void {
    if (!this.source || this.firstFrameReported || this.startupDiagnosticTimer !== undefined) return;
    const generation = this.generation;
    const revision = this.switchRevision;
    this.startupDiagnosticTimer = window.setTimeout(() => {
      this.startupDiagnosticTimer = undefined;
      // 后台容器可以暂停媒体调度，不能把后台等待误报为前台播放故障。
      if (generation !== this.generation || revision !== this.switchRevision || !this.source || this.firstFrameReported || document.hidden) return;
      logClientEvent("warn", "player_startup_pending", {
        ...this.logFields(this.source, "first_frame", "pending"), ...playbackMediaFields(this.instance),
        playerEvent: this.lastPlayerEvent, elapsedMs: Math.max(0, performance.now() - this.sourceStartedAt),
      });
    }, diagnostics.startupTimeoutMs);
  }

  /** clearStartupDiagnostic 取消已结束、暂停或被新一集替代的等待采样。 */
  private clearStartupDiagnostic(): void {
    window.clearTimeout(this.startupDiagnosticTimer);
    this.startupDiagnosticTimer = undefined;
  }

  /** emitSwitching 对 SDK 事件与 Promise 收尾去重，不修改内核事件的代际门禁。 */
  private emitSwitching(switching: boolean): void {
    if (switching === this.reportedSwitching) return;
    this.reportedSwitching = switching;
    this.callbacks.onSwitchingChange?.(switching);
  }

  private emitBuffering(buffering: boolean): void {
    if (this.buffering === buffering) return;
    this.buffering = buffering;
    this.callbacks.onBufferingChange?.(buffering);
  }

  private reportFirstFrame(fallbackMeasurement = "playing_estimate", allowEstimate = true): void {
    if (this.firstFrameReported || this.cancelFrame || !this.source || !this.pendingFirstFrame) return;
    const generation = this.generation;
    const revision = this.switchRevision;
    let cancelled = false;
    let cleanupFrame = () => undefined;
    const commit = (measurement: string, processingSeconds?: number) => {
      if (cancelled || generation !== this.generation || revision !== this.switchRevision || !this.source) return;
      cleanupFrame();
      this.cancelFrame = undefined;
      this.firstFrameReported = true;
      this.clearStartupDiagnostic();
      const preload = this.instance?.preLoadData;
      const frameProcessingMs = typeof processingSeconds === "number" && Number.isFinite(processingSeconds) && processingSeconds >= 0
        ? processingSeconds * 1_000 : undefined;
      logClientEvent("info", "official_playback_first_frame", {
        ...this.logFields(this.source, "first_frame", "success"),
        elapsedMs: Math.max(0, performance.now() - this.sourceStartedAt), measurement,
        ...playbackResourceFields(this.instance, this.sourceStartedAt), frameProcessingMs,
        preloadHit: preload?.hit, preloadBytes: preload?.length,
      });
      this.callbacks.onFirstFrame?.(this.source.vid);
    };
    const media = this.instance?.player?.video ?? this.instance?.player?.media;
    if (media?.requestVideoFrameCallback) {
      try {
        const id = media.requestVideoFrameCallback((_now, metadata) => commit("video_frame_callback", metadata?.processingDuration));
        const watchdog = window.setTimeout(() => {
          const snapshot = this.snapshot();
          if (!snapshot.paused && snapshot.currentTime > 0) commit("video_frame_watchdog");
          else {
            cleanupFrame();
            this.cancelFrame = undefined;
          }
        }, 320);
        cleanupFrame = () => {
          // 原生取消不能撤回已经排队的回调；本地门禁防止旧帧抢占新的观察任务。
          cancelled = true;
          window.clearTimeout(watchdog);
          media.cancelVideoFrameCallback?.(id);
        };
        this.cancelFrame = cleanupFrame;
      } catch (reason) {
        logClientEvent("warn", "official_video_frame_callback_failed", { error: platformErrorMessage(reason, "Video frame callback failed") });
        if (allowEstimate) commit(fallbackMeasurement);
      }
    } else if (allowEstimate) {
      // 不具备实际帧回调时明确标记估计值，不能把 LOAD_START 当成出画。
      commit(fallbackMeasurement);
    }
  }

  private logFields(source: PlaybackSource, stage: string, outcome: string) {
    return {
      flow: source.provider === "byteplus_web" ? "direct_playback" : "official_playback",
      stage,
      outcome,
      albumId: source.albumId,
      episodeId: source.episodeId,
      vid: source.vid,
    };
  }
}

/** validateOfficialSource 防止把直连凭据传给宿主官方接口。 */
function validateOfficialSource(source: PlaybackSource): void {
  if (source.provider === "byteplus_web" || source.playAuthToken || source.channel !== "byteplus" ||
      !source.albumId?.trim() || !source.episodeId?.trim() || !source.vid.trim()) {
    throw new Error("Official Player identifiers are incomplete");
  }
}
/** TikTokMinisPlayerEngine 保持官方适配入口，生命周期由共享内核实现。 */
export class TikTokMinisPlayerEngine extends SDKPlaybackEngine {}
