import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

import { text as t } from "../copy";

interface PlaybackRateSheetProps {
  /** rates 是播放器内核允许切换的倍速列表。 */
  rates: readonly number[];
  /** selected 是当前已应用到播放器内核的倍速。 */
  selected: number;
  /** onSelect 应用用户明确选择的倍速并关闭面板。 */
  onSelect(rate: number): void;
  /** onClose 关闭面板并恢复触发器焦点。 */
  onClose(): void;
}

/** PlaybackRateSheet 用原生底部弹层展示完整倍速列表，并维护键盘焦点边界。 */
export function PlaybackRateSheet({ rates, selected, onSelect, onClose }: PlaybackRateSheetProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);

  return <div className="sheet-mask playback-rate-mask" onClick={onClose}>
    <section
      ref={panelRef}
      className="playback-rate-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t("player.playbackSpeedOptions")}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled]):not([tabindex="-1"])');
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
    >
      <div className="playback-rate-options">
        {rates.map((rate) => {
          const active = rate === selected;
          return <button key={rate} type="button" aria-pressed={active} aria-label={`${rate}x`} onClick={() => onSelect(rate)}>
            <span>{rate}x</span>
            {active ? <Check aria-hidden="true" /> : null}
          </button>;
        })}
      </div>
    </section>
  </div>;
}
