import { captureAdIntent } from "../../platform/tiktok/adIntent";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoUnlockConfig, NextAdPrompt } from "../../domain/types";
import { createRewardClaim } from "../../domain/rewardClaim";
import type { Runtime } from "../../runtime/runtime";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import { text as t } from "../../copy";
import { usePlaybackGate } from "./PlaybackGate";

/** AutoUnlockPrompt 只展示服务端决定的下一次广告。 */
export interface AutoUnlockPrompt {
  /** config 保留目标入口的原文案。 */
  config: AutoUnlockConfig;
  /** episodeNumber 是服务端确定的目标集号。 */
  episodeNumber: number;
  /** unlockedCount 是结算后已解锁数量。 */
  unlockedCount: number;
  /** totalCount 是目录分集总数。 */
  totalCount: number;
  /** decide 幂等结束本轮提示，false 立即退出连续广告。 */
  decide(continueUnlock: boolean): void;
}

/** useAutoUnlock 消费领奖响应，不自行查目录、扫描权益或推断下一目标。 */
export function useAutoUnlock(runtime: Runtime, route: string) {
  const { waitUntilReady } = usePlaybackGate();
  const [prompt, setPrompt] = useState<AutoUnlockPrompt>();
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const running = useRef<symbol | undefined>(undefined);
  const pending = useRef<((proceed: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    generation.current += 1;
    setPrompt(undefined); setNotice("");
    return () => { generation.current += 1; pending.current?.(false); pending.current = undefined; running.current = undefined; };
  }, [route, runtime]);

  const run = useCallback(async (initial: NextAdPrompt | null | undefined, isCurrentVisit: () => boolean, isVisible: () => boolean, askIncomplete: (countdownSeconds?: number, displayCountdownSeconds?: number) => Promise<boolean>) => {
    // 同一页面生命周期只允许一条连续广告链，同步拦截连点和重复事件。
    if (running.current) return;
    const runID = Symbol();
    running.current = runID;
    const ticket = generation.current;
    const current = () => ticket === generation.current && isCurrentVisit();
    let next = initial;
    const dramaId = initial?.dramaId;
    setNotice("");
    try {
      while (next && current()) {
        const target = next;
        if (target.dramaId !== dramaId || target.offer.kind !== "rewarded_episode" || !target.offer.autoUnlock?.enabled) return;
        const proceed = await new Promise<boolean>(resolve => {
          let decided = false;
          const decide = (value: boolean) => {
            if (decided) return;
            decided = true; pending.current = undefined;
            if (!value && current()) logClientEvent("info", "auto_unlock_prompt_dismissed", { episodeNumber: target.episodeNumber });
            if (current()) setPrompt(undefined);
            resolve(value);
          };
          pending.current = decide;
          setPrompt({ config: target.offer.autoUnlock!, episodeNumber: target.episodeNumber,
            unlockedCount: target.unlockedCount, totalCount: target.totalCount, decide });
        });
        if (!proceed || !current()) return;
        let intent = captureAdIntent(() => current() && isVisible());
        // 门禁重查是暂停，不能把已经确认的连续解锁决定当作取消。
        if (!await waitUntilReady() || !current() || !isVisible()) return;
        // 每次重看创建新的领取身份；只有官方确认完整结束的广告才能进入结算。
        let input: ReturnType<typeof createRewardClaim>;
        while (true) {
          if (!await waitUntilReady() || !current() || !isVisible()) return;
          input = createRewardClaim(target.offer, target.dramaId, target.episodeId);
          const ad = await runtime.showRewardedAd(input.adUnitId, input, intent);
          if (!current()) return;
          if (ad.status === "completed") break;
          if (ad.status === "cancelled" && target.offer.promptOnIncomplete && await askIncomplete(target.offer.incompleteAdCountdownSeconds, target.offer.incompleteAdDisplayCountdownSeconds) && current() && isVisible()) { intent = captureAdIntent(() => current() && isVisible()); continue; }
          if (ad.status === "unknown") setNotice(t("runtime.rewardedAdPending"));
          if (ad.status === "failed" || ad.status === "unsupported") setNotice(t(ad.status === "failed" && ad.reason === "client_outdated"
            ? "runtime.rewardedAdUnavailable" : "player.autoUnlockStopped"));
          return;
        }
        // 完整观看仍需结算；换页后不再显示后续提示，账号归属由 runtime 校验。
        const claim = await runtime.claimReward(input);
        if (!current()) return;
        if (!claim.unlocked) throw new Error("Automatic episode reward was not granted");
        runtime.invalidatePlayback?.();
        next = claim.nextAd;
      }
    } catch (reason) {
      logClientEvent("error", "automatic_episode_unlock_failed", { error: safeErrorMessage(reason) });
      if (current()) setNotice(t("player.autoUnlockStopped"));
    } finally {
      if (running.current === runID) running.current = undefined;
      if (current()) setPrompt(undefined);
    }
  }, [runtime, waitUntilReady]);
  return { prompt, notice, run };
}
