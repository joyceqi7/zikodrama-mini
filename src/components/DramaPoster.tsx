import { Bookmark, Check } from "lucide-react";
import { text as t } from "../copy";
import { DramaCard } from "./DramaCard";

import type { DramaSummary } from "../domain/types";


interface DramaPosterProps {
  /** drama 是接口返回的剧目元数据。 */
  drama: DramaSummary;
  /** featured 使用官方横向首推布局。 */
  featured?: boolean;
  /** saved 只表示当前访客本机收藏状态。 */
  saved?: boolean;
  /** saveBusy 防止重复修改收藏。 */
  saveBusy?: boolean;
  /** onToggleSave 写入现有访客隔离的本地库。 */
  onToggleSave?: () => void;
  /** onSelect 在身份未完成时保留观看意图，缺省时直接进入播放路由。 */
  onSelect?: () => void;
  /** onPlaybackIntent 提前准备首页卡片的公开资源，不触发收藏或导航。 */
  onPlaybackIntent?: () => void;
}

/** DramaPoster 在官方卡片外补充实际收藏动作。 */
export function DramaPoster({ drama, featured = false, saved = false, saveBusy = false, onToggleSave, onSelect, onPlaybackIntent }: DramaPosterProps) {
  return (
    <article className="drama-poster" data-home-anchor={`drama-${drama.id}`}>
      <DramaCard drama={drama} featured={featured} onSelect={onSelect} onPlaybackIntent={onPlaybackIntent} />
      {onToggleSave && (
        <button
          type="button"
          className={`poster-save-button${saved ? " active" : ""}`}
          disabled={saveBusy}
          onClick={onToggleSave}
          aria-label={saved ? t("watchlist.saved") : t("watchlist.add")}
          aria-pressed={saved}
        >
          {saved ? <Check aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
        </button>
      )}
    </article>
  );
}
