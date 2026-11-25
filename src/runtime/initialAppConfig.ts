import { HttpMiniDramaApi } from "../api/httpMiniDramaApi";
import type { ApplicationProfile } from "../config/applicationProfile";
import type { AppConfig } from "../domain/types";
import { ensureVisibilityTracking, refreshVisibilitySnapshot, type VisibilitySnapshot } from "../platform/tiktok/lifecycle";
import { requestSilentLoginCode } from "../platform/tiktok/login";
import { ensureTikTokSDK } from "../platform/tiktok/sdkReady";
import { prepareCampaignCover } from "./campaignPreparation";

function sameForeground(initial: VisibilitySnapshot, current: VisibilitySnapshot): boolean {
  if (!initial.visible || !current.visible) return false;
  if (initial.epoch === current.epoch) return true;
  // 首次原生前台通知只确认网页已经可见；真实隐藏或同步 hide→show 会留下额外代次。
  return initial.nativeVisibility === "unknown" && current.nativeVisibility === "visible"
    && current.epoch === initial.epoch + 1
    && initial.documentVisibility === current.documentVisibility && initial.prerendering === current.prerendering;
}

function prepareLogin(search: string, visibility: VisibilitySnapshot) {
  const platformReady = ensureTikTokSDK();
  const hash = window.location.hash;
  const isCurrent = () => window.location.search === search && window.location.hash === hash
    && sameForeground(visibility, refreshVisibilitySnapshot());
  const response = platformReady.then(() => isCurrent() ? requestSilentLoginCode(window.TTMinis) : undefined);
  // 入口可能比 Runtime 早收到成功或失败，交接时保留原任务，不自动重复初始化或换码。
  void response.catch(() => { /* SDK 或登录边界已记录故障。 */ });
  return {
    platformReady,
    consume: async () => {
      // 切后台或投放参数变化后不得把旧换码凭据交给新启动。
      if (!isCurrent()) return;
      const code = await response;
      return isCurrent() ? code : undefined;
    },
  };
}

let initial: {
  tiktokAppId: string;
  apiBaseUrl: string;
  visibility: VisibilitySnapshot;
  api: HttpMiniDramaApi;
  response: Promise<AppConfig>;
  login?: ReturnType<typeof prepareLogin>;
} | undefined;

/** prepareInitialAppConfig 先读取公开配置；明确播放入口还可提前请求本次静默登录凭据。 */
export function prepareInitialAppConfig(profile: ApplicationProfile, playbackSearch?: string): void {
  ensureVisibilityTracking();
  const visibility = refreshVisibilitySnapshot();
  if (!visibility.visible) return;
  const api = new HttpMiniDramaApi(profile.apiBaseUrl);
  const response = api.appConfig(profile.tiktokAppId);
  // 等 Runtime 安装时交付原始结果；若页面尚未加载完成，拒绝也不会变成未处理异常。
  void response.catch(() => { /* API 边界已记录故障，由 Runtime 交付启动失败。 */ });
  initial = {
    tiktokAppId: profile.tiktokAppId, apiBaseUrl: profile.apiBaseUrl, visibility, api, response,
    login: playbackSearch === undefined ? undefined : prepareLogin(playbackSearch, visibility),
  };
  if (playbackSearch !== undefined) {
    const hash = window.location.hash;
    // 公开准备先发出，慢响应或旧 Server 都不能拖住身份与配置任务。
    prepareCampaignCover(api, profile.tiktokAppId, playbackSearch, () =>
      window.location.hash === hash && window.location.search === playbackSearch &&
      sameForeground(visibility, refreshVisibilitySnapshot()));
  }
}

/** takeInitialAppConfig 只让同一应用与前台周期的首个 Runtime 接管原请求及 API 实例。 */
export function takeInitialAppConfig(profile: ApplicationProfile) {
  const pending = initial;
  initial = undefined;
  if (!pending || pending.apiBaseUrl !== profile.apiBaseUrl || pending.tiktokAppId !== profile.tiktokAppId) return;
  const visibility = refreshVisibilitySnapshot();
  // 下载业务模块期间发生真实后台切换时，启动使用新的配置请求。
  if (!sameForeground(pending.visibility, visibility)) return;
  return pending;
}
