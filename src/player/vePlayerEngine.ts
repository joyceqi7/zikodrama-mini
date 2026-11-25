import { logClientEvent } from "../observability/clientLog";
import { playbackErrorFields } from "./playbackDiagnostics";
import type {
  TikTokVePlayerConstructor,
  TikTokVePlayerOptions,
} from "../platform/tiktok/types";
import { SDKPlaybackEngine } from "./tiktokMinisPlayerEngine";
import type { PlaybackSource } from "./playbackEngine";
import { readTopLevelHostname, selectVePlayerLicense, type VePlayerLicense } from "./vePlayerLicense";
import { DirectMediaInfoPrefetch, directMediaInfoOptions, isUsableDirectSource } from "./directMediaInfoPrefetch";
import { preconnectDirectMediaInfo } from "../config/mediaNetwork";
import { DirectPlayerExemptionRejected, ensureDirectPlayerExemption } from "../platform/tiktok/directPlayerExemption";

type InitializedPlayer = { player: TikTokVePlayerConstructor; license: VePlayerLicense };
type PageInitialization = { load: Promise<InitializedPlayer>; waiting?: Promise<InitializedPlayer> };
// SDK 在页面级验证许可，同一页面的预热、重建和多个适配器必须共用初始化。
const pageInitializations = new WeakMap<Window, PageInitialization>();

function initializePlayer(page: Window, platformReady?: Promise<void>): Promise<InitializedPlayer> {
  let initialization = pageInitializations.get(page);
  if (!initialization) {
    // 仅独立通道建连，和 Full JS/CSS 下载重叠；实际查询仍由 SDK 使用当集授权发起。
    preconnectDirectMediaInfo();
    let selectedLicense: VePlayerLicense | undefined;
    const load = Promise.resolve().then(async () => {
      const startedAt = performance.now();
      const hostname = readTopLevelHostname(page);
      const license = selectVePlayerLicense(hostname);
      selectedLicense = license;
      const fields = { hostname, licenseDomain: license.domain, sdkAppId: license.appId };
      logClientEvent("info", "direct_player_license_selected", fields);
      // 服务端确认独立通道后，包内 SDK、样式加载与页面校验并行。
      // 两边都成功后才配置许可并返回构造器，提前加载不提前创建播放器或授予播放权限。
      const resources = Promise.all([
        import("@byteplus/veplayer"),
        import("@byteplus/veplayer/index.min.css"),
      ]).then(([module]) => {
        logClientEvent("info", "direct_player_sdk_loaded", { ...fields, elapsedMs: Math.max(0, performance.now() - startedAt) });
        return module;
      });
      // 固定本次 SDK 就绪结果；失败正在传播时不能重新读取全局任务并隐式初始化第二次。
      const verification = platformReady
        ? platformReady.then(() => ensureDirectPlayerExemption(page))
        : ensureDirectPlayerExemption(page);
      const verified = verification.then(() => {
        logClientEvent("info", "direct_player_page_verified", { ...fields, elapsedMs: Math.max(0, performance.now() - startedAt) });
      });
      const [module] = await Promise.all([resources, verified]);
      // Content/Signature 保持原样，mainUrl 由官方 SDK 处理更新，不自行下载或改写签名。
      const licenseStartedAt = performance.now();
      await module.default.setLicenseConfig({ license: license.license });
      logClientEvent("info", "direct_player_license_ready", { ...fields, elapsedMs: Math.max(0, performance.now() - licenseStartedAt) });
      logClientEvent("info", "direct_player_prepared", { ...fields, elapsedMs: Math.max(0, performance.now() - startedAt) });
      return { player: module.default as unknown as TikTokVePlayerConstructor, license };
    }).catch(reason => {
      if (pageInitializations.get(page)?.load === load) pageInitializations.delete(page);
      const failure = playbackErrorFields(reason instanceof Error && reason.cause !== undefined ? reason.cause : reason, "Direct player initialization failed");
      let error = failure.error!;
      // 部分 SDK 异常会拼接验签输入，只隐藏本次许可值，保留其余实际错误详情。
      if (selectedLicense) for (const value of Object.values(selectedLicense.license)) {
        error = error.split(value).join("[LICENSE]");
      }
      logClientEvent(reason instanceof DirectPlayerExemptionRejected ? "warn" : "error", "direct_player_initialization_failed", {
        ...failure, error, licenseDomain: selectedLicense?.domain, sdkAppId: selectedLicense?.appId,
      });
      // 上层仍会记录初始化失败，不能把 SDK 拼接的许可或凭据继续带到其他日志边界。
      throw new Error(error);
    });
    initialization = { load };
    pageInitializations.set(page, initialization);
  }
  if (initialization.waiting) return initialization.waiting;
  const current = initialization;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error("Direct player initialization timed out");
      logClientEvent("error", "direct_player_initialization_failed", { error: reason.message });
      reject(reason);
    }, 15_000);
  });
  const waiting = Promise.race([current.load, timeout]).catch(reason => {
    // SDK 的在途验签不能取消：超时后重试仍等待同一次调用，避免迟到结果覆盖新配置。
    if (current.waiting === waiting) current.waiting = undefined;
    throw reason;
  }).finally(() => clearTimeout(timer));
  current.waiting = waiting;
  return waiting;
}

/** validateDirectSource 只接受仍有效的授权源，不接受假官方映射。 */
export function validateDirectSource(source: PlaybackSource): void {
  if (!isUsableDirectSource(source)) {
    const error = new Error("Playback authorization has expired or is not confirmed. Please retry.");
    logClientEvent("warn", "direct_playback_authorization_rejected", { error: error.message });
    throw error;
  }
}
/** directPlayerOptions 使用基础版 VID 授权与选中许可的 appId，清晰度由可用源决定，不调用高级预加载。 */
export function directPlayerOptions(
  source: PlaybackSource,
  root?: HTMLElement,
  appId?: string,
): TikTokVePlayerOptions {
  validateDirectSource(source);
  const requestedAt = performance.now();
  return {
    root,
    ...directMediaInfoOptions(source),
    lang: "en",
    autoplay: source.autoplay !== false,
    ...(source.startTime !== undefined ? { startTime: source.startTime } : {}),
    playsinline: true,
    onGetMediaInfo: data => logClientEvent("info", "direct_player_media_info_ready", {
      vid: source.vid, sdkAppId: appId, fromCache: data.fromCache === true,
      elapsedMs: Math.max(0, performance.now() - requestedAt),
    }),
    enableMp4MSE: false,
    enableDegradeMuteAutoplay: true,
    retryCount: 1,
    autoSubtitle: false,
    videoFillMode: "fillWidth",
    closeVideoClick: true,
    closeVideoDblclick: true,
    controls: { mode: "bottom" },
    ignores: [
      "Subtitle",
      "fullscreen",
      "pip",
      "volume",
      "playbackrate",
      "sdkDefinitionPlugin",
      "moreButtonPlugin",
      "play",
      "replay",
      "miniProgress",
    ],
    mobile: {
      gestureX: false,
      gestureY: false,
      closedbClick: true,
      focusVideoClick: true,
      gradient: "none",
    },
    sdkErrorPlugin: { isNeedRefreshButton: false },
    // 日志只使用 VOD 应用标识，业务观众 ID 不交给独立 SDK。
    vodLogOpts: { line_app_id: Number(appId), tag: "Direct Mini" },
  };
}
/** DirectVePlayerAdapter 将独立包的构造器适配到共用实例生命周期。 */
export class DirectVePlayerAdapter {
  private pending?: Promise<TikTokVePlayerConstructor>;
  private license?: VePlayerLicense;
  private mediaInfo?: DirectMediaInfoPrefetch;
  /** getConstructor 等待顶层域名对应许可验证，同页共享加载；platformReady 固定本次 SDK 结果，拒绝时不隐式重试初始化，缺省由页面校验等待 SDK。实际失败后允许显式重试。 */
  getConstructor(platformReady?: Promise<void>): Promise<TikTokVePlayerConstructor> {
    if (this.pending) return this.pending;
    const pending = initializePlayer(window, platformReady)
      .then(({ player, license }) => {
        this.license = license;
        this.mediaInfo = new DirectMediaInfoPrefetch(player);
        return player;
      })
      .catch((reason) => {
        if (this.pending === pending) this.pending = undefined;
        // 共享初始化边界已经记录实际失败，适配器只释放本实例的重试入口。
        throw reason;
      });
    this.pending = pending;
    return this.pending;
  }
  /** prefetchMediaInfo 复用已就绪的 SDK；冷启动即将挂载时由常规取流接管。 */
  prefetchMediaInfo(source: PlaybackSource, stage: "launch" | "next_episode"): void {
    this.mediaInfo?.start(source, stage);
  }

  /** clearMediaInfoCache 作废上一授权范围已取得或在途的播放信息。 */
  clearMediaInfoCache(): void {
    this.mediaInfo?.clear();
  }

  /** createEngine 共用进度、首帧、倍速、暂停和销毁语义，源校验保持独立。 */
  createEngine(): SDKPlaybackEngine {
    return new SDKPlaybackEngine(
      this,
      (source, root) => {
        if (!this.license) throw new Error("Direct player license is not initialized");
        return directPlayerOptions(source, root, this.license.appId);
      },
      validateDirectSource,
      (source) => this.mediaInfo?.take(source),
    );
  }
}
