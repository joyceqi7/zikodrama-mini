import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { LitePlayerConfig } from "@byteplus/veplayer/lite";
import type { TikTokVePlayerEventName } from "../platform/tiktok/types";

// 真实导入固定版本的发布模块；网络哨兵只阻止意外外联，不替换播放器或伪造播放内核。
let storageFrame: HTMLIFrameElement | undefined;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); storageFrame?.remove(); storageFrame = undefined; });

it("真实 1.19.1 Lite 暴露共用播放生命周期与事件，导入和许可配置不创建播放器或发起网络", async () => {
  // Node 25 的全局 Web Storage 会污染测试主窗口；同源 iframe 提供独立的真实 jsdom Storage。
  storageFrame = document.createElement("iframe");
  document.body.append(storageFrame);
  const browserStorage = storageFrame.contentWindow!.localStorage;
  expect(typeof browserStorage.getItem).toBe("function");
  vi.stubGlobal("localStorage", browserStorage);
  const fetch = vi.fn(() => { throw new Error("Lite contract must not make network requests"); });
  vi.stubGlobal("fetch", fetch);
  const xhr = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {
    throw new Error("Lite contract must not open XMLHttpRequest");
  });
  const beforeMediaCount = document.querySelectorAll("video, audio").length;
  const { default: LitePlayer, Events } = await import("@byteplus/veplayer/lite");

  expect(typeof LitePlayer).toBe("function");
  expect(LitePlayer.sdkVersion).toBe("1.19.1");
  expect(LitePlayer.Events).toBe(Events);
  for (const method of ["on", "off", "playNext", "destroy", "getPlayerInstance"] as const) {
    expect(typeof LitePlayer.prototype[method], method).toBe("function");
  }
  // 共用引擎依赖这些事件区分真实播放、缓冲、切集和诊断，不能用 READY 替代起播。
  const usedEvents = [
    "READY", "COMPLETE", "DURATION_CHANGE", "CANPLAY", "LOAD_START", "LOADED_META_DATA", "LOADED_DATA",
    "PLAY", "PAUSE", "ENDED", "TIME_UPDATE", "ERROR", "PLAYING", "WAITING", "STALLED", "SEEKING", "SEEKED",
    "SOURCE_ERROR", "SOURCE_SUCCESS", "TOKEN_EXPIRED", "GET_PLAY_URL_ERR", "LICENSE_STATUS_WARNING", "UMD_LOAD_FAIL",
    "URL_NULL", "AUTOPLAY_PREVENTED", "AUTOPLAY_FAILED", "LONG_WAITING", "OFTEN_WAITING", "PLAY_NEXT_START",
    "PLAY_NEXT_END", "PRELOAD_INFO",
  ] as const satisfies readonly TikTokVePlayerEventName[];
  for (const event of usedEvents) expect(Events[event], event).toEqual(expect.any(String));

  // lite.d.ts 漏声明许可静态方法，单独检查发布物的实际入口；空测试配置不含任何真实许可。
  const licenseAPI = LitePlayer as unknown as {
    /** setLicenseConfig 仅核对调用形状；Lite 1.19.1 的空实现不能证明域名或功能授权已验证。 */
    setLicenseConfig(options: { license: { content: string; sign: string } }): Promise<void>;
  };
  expect(typeof licenseAPI.setLicenseConfig).toBe("function");
  const configured = licenseAPI.setLicenseConfig({ license: { content: "", sign: "" } });
  expect(configured).toBeInstanceOf(Promise);
  await configured;

  expect(fetch).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
  expect(document.querySelectorAll("video, audio")).toHaveLength(beforeMediaCount);
});

it("Lite 公共类型接受 VID 与短时 Token 的基本配置及媒体信息回调，不依赖视频广告插件", () => {
  // 此处只核对 Lite 明确声明的基本参数；controls/retryCount/mobile.focusVideoClick 等既有扩展未被其类型声明覆盖。
  const configuration = {
    vid: "contract-only-vid",
    getVideoByToken: { playAuthToken: "contract-only-token", needPoster: true },
    lang: "en",
    autoplay: true,
    playsinline: true,
    enableMp4MSE: false,
    enableDegradeMuteAutoplay: true,
    autoSubtitle: false,
    videoFillMode: "fillWidth",
    closeVideoClick: true,
    closeVideoDblclick: true,
    mobile: { gestureX: false, gestureY: false, closedbClick: true, gradient: "none" },
    sdkErrorPlugin: { isNeedRefreshButton: false },
    vodLogOpts: { line_app_id: 1, tag: "Direct Mini" },
    // SDK 声明采用 unknown[]；生产日志边界仍须自行校验数据，不能记录原始响应。
    onGetMediaInfo: (...args: unknown[]) => { void args; },
  } satisfies LitePlayerConfig;
  expectTypeOf(configuration).toMatchTypeOf<LitePlayerConfig>();
  expect(configuration.getVideoByToken.playAuthToken).toBe("contract-only-token");
  // 激励和插屏广告由 src/platform 的 TikTok SDK 负责，播放器参数无需启用视频内 Ads。
  expect(configuration).not.toHaveProperty("Ads");
  expect(configuration).not.toHaveProperty("plugins");
});

it("真实 Lite 未安装宿主短剧桥接时拒绝独立 VID/Token 构造，导入成功不等于能够起播", async () => {
  storageFrame = document.createElement("iframe");
  document.body.append(storageFrame);
  vi.stubGlobal("localStorage", storageFrame.contentWindow!.localStorage);
  const fetch = vi.fn(() => { throw new Error("Unsupported Lite environment must not request media"); });
  vi.stubGlobal("fetch", fetch);
  const xhr = vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {
    throw new Error("Unsupported Lite environment must not request media");
  });
  const { default: LitePlayer } = await import("@byteplus/veplayer/lite");
  expect(LitePlayer.ttDramaEnv).toBeNull();
  const beforeMediaCount = document.querySelectorAll("video, audio").length;
  let failure: unknown;
  try {
    // 沿用独立通道的 VID/Token 合同，不伪造宿主环境、Album/Episode 或原生媒体源。
    new LitePlayer({
      root: document.createElement("div"), vid: "contract-only-vid",
      getVideoByToken: { playAuthToken: "contract-only-token" },
      autoplay: false, enableMp4MSE: false,
    });
  } catch (reason) { failure = reason; }
  expect(failure).toMatchObject({ name: "VePlayerLiteUnsupportedEnvironmentError", code: "VEPLAYER_LITE_UNSUPPORTED_ENVIRONMENT" });
  expect(fetch).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
  expect(document.querySelectorAll("video, audio")).toHaveLength(beforeMediaCount);
});
