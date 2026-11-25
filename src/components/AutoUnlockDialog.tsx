import { useEffect, useId, useRef, useState } from "react";
import { Coffee } from "lucide-react";
import type { AutoUnlockPrompt } from "../pages/theater/useAutoUnlock";
import { text as t } from "../copy";

interface Props {
  /** prompt 包含本轮配置、目标集号与幂等决定回调。 */
  prompt: AutoUnlockPrompt;
  /** visible 由 minis.show/hide 与页面可见性合并，后台不累计等待时间。 */
  visible: boolean;
}

/** AutoUnlockDialog 在广告之间提供明确的取消入口，取消和 Escape 都回到当前集播放。 */
export function AutoUnlockDialog({ prompt, visible }: Props) {
  const configuredSeconds = prompt.config.countdownSeconds ?? 3;
  const [timerState, setTimerState] = useState({ prompt, seconds: configuredSeconds });
  // 新提示立即采用自己的配置，避免上一轮归零状态在 effect 重置前自动确认下一轮。
  const countdown = timerState.prompt === prompt ? timerState.seconds : configuredSeconds;
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const proceed = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const contentId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    // 宿主切到后台时暂停倒计时，避免在不可见状态拉起官方广告组件。
    if (!visible) return;
    if (countdown <= 0) {
      prompt.decide(true);
      return;
    }
    const timer = window.setTimeout(() => setTimerState({ prompt, seconds: countdown - 1 }), 1_000);
    return () => window.clearTimeout(timer);
  }, [countdown, prompt, visible]);
  return <div className="auto-unlock-backdrop" onClick={() => prompt.decide(false)}>
    <section ref={dialog} tabIndex={-1} className="auto-unlock-dialog auto-unlock-chain-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={contentId}
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); prompt.decide(false); }
        if (event.key === "Tab" && event.shiftKey && (document.activeElement === proceed.current || document.activeElement === dialog.current)) { event.preventDefault(); cancel.current?.focus(); }
        else if (event.key === "Tab" && !event.shiftKey && document.activeElement === cancel.current) { event.preventDefault(); proceed.current?.focus(); }
      }}>
      <div className="auto-unlock-copy">
        <p className="auto-unlock-progress">{t("player.autoUnlockProgress", { unlocked: prompt.unlockedCount, total: prompt.totalCount })}</p>
        <h2 id={titleId}>{prompt.config.title || t("player.autoUnlockTitle", { number: prompt.episodeNumber })}</h2>
        <p id={contentId}>{prompt.config.content || t("player.autoUnlockContent")}</p>
        <button ref={proceed} type="button" className="auto-unlock-continue" aria-label={t("player.autoUnlockContinue")} onClick={() => prompt.decide(true)}><Coffee aria-hidden="true" /><span>{t("player.autoUnlockContinue")}</span><span className="auto-unlock-button-countdown" aria-hidden="true">{countdown}s</span></button>
        <button ref={cancel} type="button" className="auto-unlock-cancel" onClick={() => prompt.decide(false)}>{t("player.autoUnlockCancel")}</button>
      </div>
    </section>
  </div>;
}
