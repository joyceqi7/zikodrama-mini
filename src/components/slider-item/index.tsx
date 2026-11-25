import { memo, type ReactNode, type RefCallback } from "react";

import type { Episode } from "../../domain/types";
import { coverThumbnail } from "../coverThumbnail";

export interface SliderItemProps {
  active: boolean;
  distance: number;
  /** episode 在详情请求完成前可空；不能因此更换承载官方 Player 的 DOM。 */
  episode?: Episode;
  /** @deprecated 海报不属于播放凭证，保留此参数仅兼容旧调用方。 */
  previewable: boolean;
  /** resumeFromHistory 保留调用契约；恢复目标位置前仍显示首图以避免黑屏。 */
  resumeFromHistory?: boolean;
  /** fallbackPosterUrl 在剧集缺少独立首图时使用短剧封面，避免滑动页黑底。 */
  fallbackPosterUrl?: string;
  hostRef: RefCallback<HTMLDivElement>;
  children?: ReactNode;
}
/**
 * 官方 H5 短剧 Demo 的每屏容器：相邻屏保留封面，只有当前屏承载播放器和业务浮层。
 */
export const SliderItem = memo(function SliderItem({
  active,
  distance,
  episode,
  previewable,
  fallbackPosterUrl = "",
  hostRef,
  children,
}: SliderItemProps) {
  // 活跃屏的画面交给官方 Player，不能再叠一张业务封面或在缓冲时闪回首图。
  void previewable;
  const shouldRenderPoster = !active && Math.abs(distance) <= 2;
  const posterUrl = episode?.posterUrl.trim() || fallbackPosterUrl.trim();
  const posterSource = coverThumbnail(posterUrl, 720);

  return (
    <section
      className={`video-slider-item${active ? " active" : ""}`}
      data-episode-id={episode?.id}
      aria-hidden={!active}
    >
      {shouldRenderPoster && posterUrl && (
        <img
          className="video-slider-poster"
          src={posterSource}
          alt=""
          aria-hidden="true"
          decoding="async"
          draggable={false}
          loading={Math.abs(distance) <= 1 ? "eager" : "lazy"}
          onError={(event) => {
            if (posterSource !== posterUrl && event.currentTarget.src !== posterUrl) event.currentTarget.src = posterUrl;
          }}
        />
      )}
      <div
        ref={hostRef}
        className="video-slider-player-host"
        data-player-host={episode?.id}
      />
      {active ? children : null}
    </section>
  );
});
