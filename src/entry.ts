import { currentApplicationProfile } from "./config/applicationProfile";
import { applyCampaignPreview, hasPlaybackLaunch, readCampaignCover } from "./runtime/launchRoute";
import { showCampaignEntryCover } from "./runtime/campaignEntryCover";
import { prepareInitialAppConfig } from "./runtime/initialAppConfig";
import { preconnectMediaCDN } from "./config/mediaNetwork";
import { showStartupError } from "./runtime/startupError";

try {
  if (import.meta.env.VITE_MINIS_PREVIEW_BUILD === "1") {
    const preview = document.querySelector<HTMLMetaElement>('meta[name="minis-preview-campaign"]');
    if (preview) applyCampaignPreview(preview.content, preview.dataset.launchQuery);
  }
  const route = window.location.hash.replace(/^#/, "").replace(/\/$/, "");
  const playbackLaunch = hasPlaybackLaunch(window.location.hash, window.location.search);
  if (route !== "/privacy" && route !== "/agreement") {
    const profile = currentApplicationProfile();
    if (playbackLaunch) {
      preconnectMediaCDN();
      const cover = readCampaignCover(window.location.hash, window.location.search);
      if (cover) showCampaignEntryCover(cover);
    }
    // 登录换码、配置与业务模块并行；身份安装和播放授权仍由 Runtime 负责。
    prepareInitialAppConfig(profile, playbackLaunch ? window.location.search : undefined);
  }
  const homeEntry = !route && !playbackLaunch;
  const business = import("./main");
  // 冷进首页时同时下载业务、React 和首页代码；投放仍先启动身份和播放器，再加载 React。
  const ui = homeEntry ? import("./mountApplication") : business.then(() => import("./mountApplication"));
  const home = homeEntry ? import("./pages/square") : undefined;
  void Promise.all([business, ui, home]).then(([{ mountPreparedApplication }, { mountApplication }, square]) => {
    mountPreparedApplication(mountApplication, square?.SquarePage);
  }).catch(showStartupError);
} catch (reason) {
  showStartupError(reason);
}
