import { useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import type { DramaDetail } from "../domain/types";
import { text as t } from "../copy";
import { buildEpisodeRanges, EPISODES_PER_RANGE } from "../pages/theater/episodeRanges";
import { MediaImage } from "./MediaImage";

interface EpisodeSheetProps {
  /** drama 为当前身份获得的详情；已解锁集由 API 刷新 accessMode。 */
  drama: DramaDetail;
  /** episodeId 是当前业务分集标识，不是官方媒体标识。 */
  episodeId: string;
  /** vipActive 只影响锁定提示，实际播放仍须 API 验权。 */
  vipActive: boolean;
  /** onClose 关闭面板并恢复触发器焦点。 */
  onClose(): void;
  /** onSelect 请求切集，不直接向 Player 传入媒体。 */
  onSelect(episodeId: string): void;
}

/** EpisodeSheet 展示封面、剧名和每组 30 集的网格；播放标记独立定位，不改变居中集号。 */
export function EpisodeSheet({ drama, episodeId, vipActive, onClose, onSelect }: EpisodeSheetProps) {
  const ranges = buildEpisodeRanges(drama.episodes);
  const current = Math.max(0, drama.episodes.findIndex((episode) => episode.id === episodeId));
  const [pageIndex, setPageIndex] = useState(Math.floor(current / EPISODES_PER_RANGE));
  const panelRef = useRef<HTMLElement>(null);
  const rangeRef = useRef<HTMLDivElement>(null);
  const rangeSwipeStartX = useRef<number | null>(null);
  const selected = ranges[pageIndex] ?? ranges[0];
  const hasLocked = !vipActive && drama.episodes.some((episode) => episode.accessMode === "rewarded");

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    // 初次打开将焦点放在弹层容器，避免范围页签自动获得焦点并露出视觉方框。
    panelRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);

  return <div className="sheet-mask" onClick={onClose}>
    <section ref={panelRef} className="episode-sheet" role="dialog" aria-modal="true" aria-label={t("player.episodeSelector")} tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])');
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <button type="button" className="episode-sheet-handle" onClick={onClose} aria-label={t("common.close")}><span aria-hidden="true" /></button>
      <header>
        <MediaImage src={drama.coverUrl} className="episode-sheet-cover" loading="eager" />
        <div className="episode-sheet-info">
          <h2 className="episode-sheet-title">{drama.title}</h2>
          <p className="episode-sheet-subtitle">{t("drama.episodeCount", { count: drama.episodeCount })}</p>
        </div>
      </header>
      <div ref={rangeRef} className="episode-ranges" role="tablist" aria-label={t("player.episodeSelector")}
        onKeyDown={(event) => {
          const directions: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -pageIndex, End: ranges.length - 1 - pageIndex };
          if (!(event.key in directions) || !ranges.length) return;
          event.preventDefault();
          const next = (pageIndex + directions[event.key] + ranges.length) % ranges.length;
          setPageIndex(next);
          rangeRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
        }}>
        {ranges.map((range, index) => <button key={range.label} type="button" role="tab" aria-selected={pageIndex === index} tabIndex={pageIndex === index ? 0 : -1} onClick={() => setPageIndex(index)}>{range.label}</button>)}
      </div>
      {hasLocked ? <p className="episode-access-legend"><LockKeyhole size={13} aria-hidden="true" />{t("player.rewardedEpisodeHint")}</p> : null}
      <div className="episode-grid"
        onPointerDown={(event) => { rangeSwipeStartX.current = event.clientX; }}
        onPointerUp={(event) => {
          const startX = rangeSwipeStartX.current;
          rangeSwipeStartX.current = null;
          if (startX === null || ranges.length < 2) return;
          const deltaX = event.clientX - startX;
          if (Math.abs(deltaX) < 40) return;
          setPageIndex((value) => Math.max(0, Math.min(ranges.length - 1, value + (deltaX < 0 ? 1 : -1))));
        }}
        onPointerCancel={() => { rangeSwipeStartX.current = null; }}>
        {selected?.episodes.map((episode) => {
          const playing = episode.id === episodeId;
          const locked = episode.accessMode === "rewarded" && !vipActive;
          return <button key={episode.id} type="button" className={[playing ? "is-current" : "", locked ? "is-locked" : ""].filter(Boolean).join(" ")}
            aria-current={playing ? "true" : undefined}
            aria-label={[t("drama.episode", { number: episode.number }), playing ? t("player.nowPlaying") : "", locked ? t("player.rewardedEpisode") : ""].filter(Boolean).join(", ")}
            onClick={() => { onClose(); onSelect(episode.id); }}>
            <b>{episode.number}</b>
            {playing ? <i className="episode-now-playing" aria-hidden="true"><span /><span /><span /></i> : null}
            {locked ? <span className="episode-access-badge" role="img" aria-label={t("player.rewardedEpisode")}><LockKeyhole size={10} aria-hidden="true" /></span> : null}
          </button>;
        })}
      </div>
    </section>
  </div>;
}
