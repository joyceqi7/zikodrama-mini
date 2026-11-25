import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { SquarePlay } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { AccountHeader } from "../components/AccountHeader";
import { BottomNav } from "../components/BottomNav";
import { coverThumbnail } from "../components/coverThumbnail";
import { text as t } from "../copy";
import type { LocalHistoryRecord } from "../domain/localLibrary";
import { logClientEvent } from "../observability/clientLog";
import { useRuntime } from "../runtime/RuntimeContext";

/** LibraryPage 同步展示当前主体本机保存的历史；进入短剧后才通过既有流程刷新摘要和验权。 */
export function LibraryPage() {
  const library = useRuntime().localLibrary;
  const seen = new Set<string>();
  const history = library.history().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).filter(item => {
    if (seen.has(item.dramaId)) return false;
    seen.add(item.dramaId);
    return true;
  });
  return (
    <main className="account-page library-page">
      <AccountHeader />
      <div className="history-content">
        <h1 className="history-filter"><ClockIcon aria-hidden="true" />{t("library.history")}</h1>
        {history.length > 0
          ? <ul className="history-list" aria-label={t("library.watchHistory")}>
              {history.map((item, index) => <li key={item.dramaId}><HistoryRow item={item} visibleOnEntry={index < 3} /></li>)}
            </ul>
          : <section className="history-empty">
              <ClockIcon aria-hidden="true" /><h2>{t("library.noHistory")}</h2><p>{t("library.noHistoryDetail")}</p>
            </section>}
      </div>
      <BottomNav />
    </main>
  );
}

/** HistoryRow 展示真实题材和集数，进度条仅表达本机播放进度，不代表服务端播放权益。 */
function HistoryRow({ item, visibleOnEntry }: {
  /** item 是该剧最近一次观看的分集记录及当时保存的可选摘要，每部剧仅展示一项。 */
  item: LocalHistoryRecord;
  /** visibleOnEntry 让首屏海报立即请求，屏外记录继续由浏览器延迟加载。 */
  visibleOnEntry: boolean;
}) {
  const { dramaId, drama, episodeId, episodeNumber, progressSeconds, durationSeconds } = item;
  const coverUrl = drama?.coverUrl.trim() || "";
  const thumbnailUrl = coverThumbnail(coverUrl, 480);
  const [failedCover, setFailedCover] = useState("");
  const progress = Math.min(100, Math.max(0, progressSeconds / Math.max(1, durationSeconds) * 100));
  return (
    <Link className="history-row" to={`/watch/${encodeURIComponent(dramaId)}/${encodeURIComponent(episodeId)}`}>
      <span className="history-poster">
        {coverUrl && failedCover !== coverUrl ? <img src={thumbnailUrl} alt="" loading={visibleOnEntry ? "eager" : "lazy"} fetchPriority={visibleOnEntry ? "high" : "low"} decoding="async" onError={(event) => {
          // 缩略图不可用时回退原图；只有两者都失败才显示占位图。
          if (event.currentTarget.getAttribute("src") !== coverUrl) {
            event.currentTarget.src = coverUrl;
            return;
          }
          logClientEvent("warn", "history_cover_load_failed", { error: "Thumbnail and original cover image failed to load" });
          setFailedCover(coverUrl);
        }} /> : <SquarePlay aria-hidden="true" className="history-poster-icon" />}
        <progress className="history-progress" max={100} value={progress} aria-label={t("history.episodeProgress", { number: episodeNumber })} />
      </span>
      <span className="history-copy">
        <strong>{drama?.title || t("history.savedDrama")}</strong>
        {drama && drama.tags.length > 0 && <span className="history-tags">{drama.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>}
        <span className="history-episode">{drama ? t("history.episodeSummary", { current: episodeNumber, total: drama.episodeCount }) : t("history.savedEpisode", { current: episodeNumber })}</span>
      </span>
    </Link>
  );
}
