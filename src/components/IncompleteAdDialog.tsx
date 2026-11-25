import { useEffect, useId, useRef, useState } from "react";
import { Play } from "lucide-react";
import { text as t } from "../copy";
import type { IncompleteAdPrompt } from "../pages/theater/useIncompleteAdPrompt";

interface Props {
  /** prompt 仅控制本次未看完广告的选择，不代表已获得奖励。 */
  prompt: IncompleteAdPrompt;
  /** visible 由小程序前后台状态控制，后台不累计倒计时。 */
  visible: boolean;
}

/** IncompleteAdDialog 提示重新观看完整广告，倒计时结束自动重开且不可在弹窗内关闭。 */
export function IncompleteAdDialog({ prompt, visible }: Props) {
  const actualMilliseconds = Math.max(1, prompt.countdownSeconds) * 1_000;
  const displaySeconds = Math.max(1, prompt.displayCountdownSeconds ?? prompt.countdownSeconds);
  const [timerState, setTimerState] = useState({ prompt, remainingMilliseconds: actualMilliseconds });
  const remainingMilliseconds = timerState.prompt === prompt ? timerState.remainingMilliseconds : actualMilliseconds;
  const countdown = Math.ceil(remainingMilliseconds * displaySeconds / actualMilliseconds);
  const progressRef = useRef({ prompt, remainingMilliseconds: actualMilliseconds });
  const dialog = useRef<HTMLElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const contentId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    continueButton.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    // 宿主切到后台时暂停倒计时，避免不可见时拉起官方广告组件。
    if (!visible) return;
    if (progressRef.current.prompt !== prompt) {
      progressRef.current = { prompt, remainingMilliseconds: actualMilliseconds };
    }
    // 显示数字按真实等待时间等比例走到零；显示 5 秒、等待 3 秒时每约 0.6 秒减一。
    const startingMilliseconds = progressRef.current.remainingMilliseconds;
    const startedAt = performance.now();
    let timer: number;
    const tick = () => {
      const next = Math.max(0, startingMilliseconds - (performance.now() - startedAt));
      progressRef.current = { prompt, remainingMilliseconds: next };
      setTimerState({ prompt, remainingMilliseconds: next });
      if (next <= 0) {
        prompt.decide(true);
        return;
      }
      const displayed = Math.ceil(next * displaySeconds / actualMilliseconds);
      const nextBoundary = (displayed - 1) * actualMilliseconds / displaySeconds;
      timer = window.setTimeout(tick, Math.max(1, next - nextBoundary));
    };
    const startingDisplay = Math.ceil(startingMilliseconds * displaySeconds / actualMilliseconds);
    const firstBoundary = (startingDisplay - 1) * actualMilliseconds / displaySeconds;
    timer = window.setTimeout(tick, Math.max(1, startingMilliseconds - firstBoundary));
    return () => {
      window.clearTimeout(timer);
      progressRef.current = { prompt, remainingMilliseconds: Math.max(0, startingMilliseconds - (performance.now() - startedAt)) };
    };
  }, [actualMilliseconds, displaySeconds, prompt, visible]);

  return <div className="auto-unlock-backdrop">
    <section ref={dialog} tabIndex={-1} className="auto-unlock-dialog incomplete-ad-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={contentId}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        if (event.key === "Tab") { event.preventDefault(); continueButton.current?.focus(); }
      }}>
      <div className="auto-unlock-copy">
        <p className="auto-unlock-kicker">{t("player.resumeUnlockKicker")}</p>
        <h2 id={titleId}>{t("player.resumeUnlockTitle")}</h2>
        <p id={contentId}>{t("player.resumeUnlockContent")}</p>
        <p className="auto-unlock-countdown" role="status">{t("player.resumeUnlockCountdown", { seconds: countdown })}</p>
        <button ref={continueButton} type="button" className="auto-unlock-continue" onClick={() => prompt.decide(true)}><Play aria-hidden="true" /><span>{t("player.resumeUnlockContinue")}</span></button>
      </div>
    </section>
  </div>;
}
