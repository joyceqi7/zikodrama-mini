import { Link } from "react-router-dom";
import type { PointerEvent } from "react";
import type { DramaSummary } from "../domain/types";
import { playbackEntryPath } from "../domain/resumePlayback";
import { useRuntime } from "../runtime/RuntimeContext";
import { text as t } from "../copy";
import { MediaImage } from "./MediaImage";

interface DramaCardProps {
  /** drama 来自真实公开目录或当前主体的发现接口。 */
  drama: DramaSummary;
  /** featured 使用官方示例的横向首推卡片。 */
  featured?: boolean;
  /** onSelect 供公开目录暂存播放意图；缺省时使用现有深链。 */
  onSelect?: () => void;
  /** onPlaybackIntent 在首页按下卡片时准备公开资源，实际导航仍由点击触发。 */
  onPlaybackIntent?: () => void;
}

/** DramaCard 复用官方示例的卡片结构，数据与路由映射到现有业务合同。 */
export function DramaCard({ drama, featured = false, onSelect, onPlaybackIntent }: DramaCardProps) {
  const runtime = useRuntime();
  const className = `drama-card${featured ? " featured-card" : ""}`;
  const onPointerDown = onPlaybackIntent && ((event: PointerEvent) => {
    if (event.button <= 0 && event.isPrimary !== false) onPlaybackIntent();
  });
  const content = <>
    <span className="cover-frame"><MediaImage src={drama.coverUrl} loading="lazy" decoding="async" sizes="(max-width: 430px) calc((100vw - 44px) / 2), 193px" /></span>
    <span className="card-copy">
      <strong>{drama.title}</strong>
      <small>{drama.tags.slice(0, 2).join(" / ") || t("drama.shortEpisodeCount", { count: drama.episodeCount })}</small>
    </span>
  </>;
  // 登录完成时保留同一触控节点，避免在按下和松手之间替换卡片；未登录时也不读取个人续播记录。
  const path = playbackEntryPath(onSelect ? [] : runtime.localLibrary.history(), drama);
  return <Link
    data-preload-resume={onSelect ? undefined : "true"}
    data-preload-drama={onSelect ? undefined : drama.id}
    data-preload-episode={onSelect ? undefined : drama.firstEpisodeId}
    className={className}
    to={path}
    onPointerDown={onPointerDown}
    onClick={onSelect && (event => { event.preventDefault(); onSelect(); })}
  >{content}</Link>;
}
