/** 自动解锁交互夹具：只替换 SDK、API 与播放内核，不进入正式应用。 */
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import { PlayerPage } from "../../src/pages/PlayerPage";
import { RuntimeContext } from "../../src/runtime/RuntimeContext";
import type { Runtime } from "../../src/runtime/runtime";
import type { AdExperience, DramaDetail, PlayResolveResult, RewardClaim } from "../../src/domain/types";
import { showRewardedAd } from "../../src/platform/tiktok/rewardedAd";
import type { RewardedVideoAd, TikTokMinisSDK } from "../../src/platform/tiktok/types";
import type { PlaybackCallbacks, PlaybackEngine } from "../../src/player/playbackEngine";
import "../../src/styles.css";
import "../../src/official-ui.css";

const drama: DramaDetail = {
  id: "1", firstEpisodeId: "1", title: "自动解锁验证", description: "", coverUrl: "", tags: [], status: "completed", episodeCount: 3,
  episodes: [1, 2, 3].map(number => ({ id: String(number), dramaId: "1", number, title: `Episode ${number}`, description: "", posterUrl: "", durationSeconds: 60, accessMode: "rewarded" })),
};
const experience: AdExperience = {
  vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "2026-09-16" },
  monetizationPolicy: { status: "enabled", strategy: "episode_reward", freeEpisodeCount: 0, episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 }, vip: { enabled: false, requiredAdCount: 1, title: "", content: "" } },
};
const unlocked = new Set<string>();
let shown = 0;
const lifecycle = new Map<string, () => void>();
const sdk = {
  canIUse: () => true,
  on: (name: string, listener: () => void) => { lifecycle.set(name, listener); return name; },
  off: (name: string) => lifecycle.delete(name),
  createRewardedVideoAd: (): RewardedVideoAd => {
    let close: Parameters<RewardedVideoAd["onClose"]>[0] | undefined;
    let dialog: HTMLDialogElement | undefined;
    return {
      async show() {
        shown += 1;
        lifecycle.get("minis.hide")?.();
        dialog = document.createElement("dialog");
        dialog.setAttribute("aria-label", "广告 SDK 测试替身");
        dialog.style.cssText = "background:#222;color:white;padding:24px;border:1px solid #777;border-radius:12px;max-width:320px";
        const label = document.createElement("p");
        label.textContent = `广告已自动拉起（第 ${shown} 次）`;
        dialog.append(label);
        for (const [name, isEnded] of [["模拟完整观看", true], ["模拟提前关闭", false], ["完成广告，稍后返回", true]] as const) {
          const button = document.createElement("button");
          button.textContent = name;
          button.style.cssText = "display:block;padding:12px;margin-top:12px;background:#444;border:0";
          button.onclick = () => {
            close?.({ isEnded });
            if (name === "完成广告，稍后返回") {
              label.textContent = "完整观看已回调，等待返回小程序";
              dialog?.querySelectorAll("button").forEach(item => item.remove());
              const back = document.createElement("button");
              back.textContent = "返回小程序";
              back.onclick = () => { dialog?.close(); dialog?.remove(); lifecycle.get("minis.show")?.(); };
              dialog?.append(back);
            } else { dialog?.close(); dialog?.remove(); lifecycle.get("minis.show")?.(); }
          };
          dialog.append(button);
        }
        dialog.addEventListener("cancel", event => { event.preventDefault(); dialog?.close(); close?.({ isEnded: false }); dialog?.remove(); lifecycle.get("minis.show")?.(); });
        document.body.append(dialog); dialog.showModal();
      },
      onClose(callback) { close = callback; }, offClose() { close = undefined; }, onError() {}, offError() {},
    };
  },
} as unknown as TikTokMinisSDK;
window.TTMinis = sdk;
let playerRoot: HTMLElement | undefined;
let playerCallbacks: PlaybackCallbacks | undefined;
let playerVid = "";
let paused = true;
const engine: PlaybackEngine = {
  async mount(root, source, callbacks) {
    playerRoot = root; playerCallbacks = callbacks; playerVid = source.vid; paused = true;
    root.textContent = "已解锁，等待播放";
    root.style.cssText = "display:grid;place-items:center;color:white";
    callbacks?.onReady?.(); return true;
  },
  async switchSource() {},
  async play() {
    paused = false;
    if (playerRoot) playerRoot.textContent = "解锁成功，已自动播放";
    playerCallbacks?.onFirstFrame?.(playerVid); playerCallbacks?.onPlay?.();
  },
  pause() { paused = true; }, seek() {}, destroy() {},
  snapshot: () => ({ currentTime: 0, duration: 60, paused, ended: false }),
};
const runtime = {
  api: { drama: async () => ({ ...drama, episodes: drama.episodes.map(episode => unlocked.has(episode.id) ? { ...episode, accessMode: "unlocked" as const } : episode) }), resolvePlay: async (_dramaId: string, id: string): Promise<PlayResolveResult> => unlocked.has(id)
    ? { status: "playable", drama, episode: drama.episodes.find(episode => episode.id === id)!, playback: { channel: "byteplus", albumId: "1", episodeId: id, vid: id, posterUrl: "", title: `Episode ${id}`, episodeNumber: Number(id), durationSeconds: 60 } }
    : { status: "access_required", drama, episode: drama.episodes.find(episode => episode.id === id)!, offer: { offerId: "1", adUnitId: "1", kind: "rewarded_episode", ruleCode: "episode", promptOnIncomplete: true, incompleteAdCountdownSeconds: 3, incompleteAdDisplayCountdownSeconds: 5, autoUnlock: { enabled: true, countdownSeconds: 5 } } } },
  getAdExperience: () => experience, subscribeAdExperience: () => () => {},
  // 故意不发送权益事件，验证当前领奖流程也能主动更新页面。
  subscribeEntitlements: () => () => {},
  createPlaybackEngine: () => engine,
  showRewardedAd: (adUnitId: string) => showRewardedAd(sdk, adUnitId),
  claimReward: async (claim: RewardClaim) => { unlocked.add(claim.episodeId!); return { ...claim, status: "granted", unlocked: true, rewardType: "episode_unlock" }; },
} as unknown as Runtime;
createRoot(document.getElementById("root")!).render(<RuntimeContext.Provider value={runtime}><HashRouter><Routes>
  <Route path="/watch/:dramaId/:episodeId" element={<PlayerPage />} />
</Routes></HashRouter></RuntimeContext.Provider>);
