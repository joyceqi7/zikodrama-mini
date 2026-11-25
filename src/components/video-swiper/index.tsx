import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MouseEventHandler,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { Episode } from "../../domain/types";
import { coverThumbnail } from "../coverThumbnail";
import { SliderItem } from "../slider-item";
import { isPlayerInteractiveTarget } from "./gesture";

export interface VideoSwiperProps {
  activeEpisodeId: string;
  children: ReactNode;
  chromeVisible: boolean;
  /** 长按加速时仅保留视频与普通进度条。 */
  speeding?: boolean;
  episodes: Episode[];
  fallbackPosterUrl?: string;
  /** @deprecated 海报不包含播放凭证，保留此参数仅兼容旧调用方。 */
  previewableEpisodeIds?: ReadonlySet<string>;
  /** @deprecated 首帧前统一展示目标首图，保留此参数仅兼容旧调用方。 */
  resumeEpisodeIds?: ReadonlySet<string>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onLongPressStart?(): void;
  onLongPressEnd?(): void;
  longPressEnabled?: boolean;
  onEpisodeChange(episodeId: string): void;
  playerRootRef: MutableRefObject<HTMLDivElement | null>;
  swipeEnabled: boolean;
}

const SETTLE_MS = 260;
const MIRROR_MOUSE_POINTER_ID = -1;
const WHEEL_IDLE_MS = 180;

/**
 * 官方短剧 Demo 的三屏轨道：播放器始终留在中间屏，只移动轨道。
 * 切集期间上下屏用首图承接，避免把正在解码的 Player DOM 搬到另一个节点而重建 iOS 视频层。
 */
export function VideoSwiper({
  activeEpisodeId,
  children,
  chromeVisible,
  speeding,
  episodes,
  fallbackPosterUrl,
  onClick,
  onLongPressStart,
  onLongPressEnd,
  longPressEnabled = false,
  onEpisodeChange,
  playerRootRef,
  swipeEnabled,
}: VideoSwiperProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeEpisodeIdRef = useRef(activeEpisodeId);
  activeEpisodeIdRef.current = activeEpisodeId;
  const [visualEpisodeId, setVisualEpisodeId] = useState(activeEpisodeId);
  const [settling, setSettling] = useState(false);
  const dragRef = useRef<{ id: number; x: number; y: number } | undefined>(undefined);
  const dragOffsetRef = useRef(0);
  const dragFrameRef = useRef<number | undefined>(undefined);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const lastPointerEventAtRef = useRef(Number.NEGATIVE_INFINITY);
  const wheelRef = useRef<{ offset: number; committed: boolean; timer?: number }>({ offset: 0, committed: false });
  const holdRef = useRef<{ id: number; x: number; y: number; timer: number; active: boolean } | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const callbacksRef = useRef({ onLongPressStart, onLongPressEnd });
  callbacksRef.current = { onLongPressStart, onLongPressEnd };
  const playerRoot = useMemo(() => {
    const root = document.createElement("div");
    root.className = "player-root";
    return root;
  }, []);
  playerRootRef.current = playerRoot;

  const visualIndex = Math.max(0, episodes.findIndex((episode) => episode.id === visualEpisodeId));
  const currentEpisode = episodes[visualIndex];
  const previousEpisode = episodes[visualIndex - 1];
  const nextEpisode = episodes[visualIndex + 1];

  const stopHold = useCallback(() => {
    const hold = holdRef.current;
    if (!hold) return;
    window.clearTimeout(hold.timer);
    holdRef.current = undefined;
    if (hold.active) {
      suppressClickRef.current = true;
      callbacksRef.current.onLongPressEnd?.();
    }
  }, []);

  const cancelDragFrame = useCallback(() => {
    if (dragFrameRef.current !== undefined) window.cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = undefined;
  }, []);

  const setTrackOffset = useCallback((offset: number) => {
    if (trackRef.current) trackRef.current.style.transform = `translate3d(0, calc(-100% + ${offset}px), 0)`;
  }, []);

  const scheduleDrag = useCallback((offset: number) => {
    dragOffsetRef.current = offset;
    if (dragFrameRef.current !== undefined) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = undefined;
      // 手势每帧只修改合成层，不让三屏、播放器和业务浮层跟着 React 重渲染。
      setTrackOffset(dragOffsetRef.current);
    });
  }, [setTrackOffset]);

  useEffect(() => {
    if (!settling && activeEpisodeId !== visualEpisodeId) setVisualEpisodeId(activeEpisodeId);
  }, [activeEpisodeId, settling, visualEpisodeId]);

  useEffect(() => {
    const updateViewportHeight = () => document.documentElement.style.setProperty("--app-vh", `${window.innerHeight * 0.01}px`);
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  useEffect(() => {
    if (!longPressEnabled) stopHold();
  }, [longPressEnabled, stopHold]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // React 的滚轮/触摸监听可能为 passive；只在视频手势区阻止 WebView 同时滚动。
    // 切集结算及首尾边界同样阻止回弹，官方控件与可滚动业务区域不受影响。
    const preventNativeScroll = (event: Event) => {
      if (event.cancelable && !isPlayerInteractiveTarget(event.target)) event.preventDefault();
    };
    stage.addEventListener("wheel", preventNativeScroll, { passive: false });
    stage.addEventListener("touchmove", preventNativeScroll, { passive: false });
    return () => {
      stage.removeEventListener("wheel", preventNativeScroll);
      stage.removeEventListener("touchmove", preventNativeScroll);
    };
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", stopHold);
    window.addEventListener("pointercancel", stopHold);
    return () => {
      window.removeEventListener("pointerup", stopHold);
      window.removeEventListener("pointercancel", stopHold);
    };
  }, [stopHold]);

  useEffect(() => () => {
    stopHold();
    cancelDragFrame();
    window.clearTimeout(settleTimerRef.current);
    window.clearTimeout(wheelRef.current.timer);
    playerRoot.remove();
  }, [cancelDragFrame, playerRoot, stopHold]);

  const attachPlayerRoot = useCallback((node: HTMLDivElement | null) => {
    if (node && playerRoot.parentElement !== node) node.appendChild(playerRoot);
  }, [playerRoot]);

  useLayoutEffect(() => {
    if (!playerRoot.isConnected) {
      const host = stageRef.current?.querySelector<HTMLDivElement>(".video-slider-item.active .video-slider-player-host");
      if (host) host.appendChild(playerRoot);
    }
  });

  const finishDrag = useCallback((direction: -1 | 0 | 1) => {
    cancelDragFrame();
    dragRef.current = undefined;
    const target = direction < 0 ? nextEpisode : direction > 0 ? previousEpisode : undefined;
    // 在样式写入前测量，避免结算动画强制同步布局。
    const height = target && swipeEnabled ? stageRef.current?.getBoundingClientRect().height || window.innerHeight : 0;
    trackRef.current?.classList.add("is-settling");
    setSettling(true);
    if (!target || !swipeEnabled) {
      dragOffsetRef.current = 0;
      setTrackOffset(0);
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        trackRef.current?.classList.remove("is-settling");
        setSettling(false);
      }, SETTLE_MS);
      return;
    }

    suppressClickRef.current = true;
    dragOffsetRef.current = direction < 0 ? -height : height;
    setTrackOffset(dragOffsetRef.current);
    // 路由、验权与 playNext 和滑页动画并行；视觉集在动画结束后再提交，目标首图不会中途换位。
    onEpisodeChange(target.id);
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      if (activeEpisodeIdRef.current === target.id) setVisualEpisodeId(target.id);
      dragOffsetRef.current = 0;
      trackRef.current?.classList.remove("is-settling");
      setTrackOffset(0);
      setSettling(false);
    }, SETTLE_MS);
  }, [cancelDragFrame, nextEpisode, onEpisodeChange, previousEpisode, setTrackOffset, swipeEnabled]);

  const beginGesture = (id: number, x: number, y: number, target: EventTarget | null, mouseButton?: number) => {
    suppressClickRef.current = false;
    if (settling || !swipeEnabled || isPlayerInteractiveTarget(target) || (mouseButton !== undefined && mouseButton !== 0)) return;
    dragRef.current = { id, x, y };
    dragOffsetRef.current = 0;
    if (!longPressEnabled) return;
    stopHold();
    const hold = { id, x, y, timer: 0, active: false };
    hold.timer = window.setTimeout(() => {
      if (holdRef.current !== hold) return;
      hold.active = true;
      callbacksRef.current.onLongPressStart?.();
    }, 350);
    holdRef.current = hold;
  };

  const moveGesture = (id: number, x: number, y: number) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id || settling) return;
    const deltaX = x - drag.x;
    let deltaY = y - drag.y;
    const holdTolerance = holdRef.current?.active ? 48 : 12;
    if (Math.abs(deltaY) > holdTolerance || Math.abs(deltaX) > holdTolerance) {
      stopHold();
      suppressClickRef.current = true;
    }
    if (holdRef.current?.active) return;
    if (Math.abs(deltaX) > Math.abs(deltaY)) return;
    if ((!previousEpisode && deltaY > 0) || (!nextEpisode && deltaY < 0)) deltaY *= 0.22;
    scheduleDrag(deltaY);
  };

  const endGesture = (id: number) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) return;
    stopHold();
    const threshold = Math.min(120, (stageRef.current?.getBoundingClientRect().height || window.innerHeight) * 0.16);
    const offset = dragOffsetRef.current;
    finishDrag(Math.abs(offset) < threshold ? 0 : offset < 0 ? -1 : 1);
  };

  const startPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerEventAtRef.current = Date.now();
    beginGesture(event.pointerId, event.clientX, event.clientY, event.target, event.pointerType === "mouse" ? event.button : undefined);
    if (dragRef.current?.id === event.pointerId) {
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* 部分镜像 WebView 不实现指针捕获，保留窗口内手势。 */ }
    }
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerEventAtRef.current = Date.now();
    moveGesture(event.pointerId, event.clientX, event.clientY);
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerEventAtRef.current = Date.now();
    endGesture(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* 指针可能已由镜像宿主释放。 */ }
  };

  const pointerEventsRecentlyHandled = () => Date.now() - lastPointerEventAtRef.current < 500;

  const startMouse = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (pointerEventsRecentlyHandled()) return;
    beginGesture(MIRROR_MOUSE_POINTER_ID, event.clientX, event.clientY, event.target, event.button);
  };

  const moveMouse = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (pointerEventsRecentlyHandled() || (event.buttons & 1) === 0) return;
    moveGesture(MIRROR_MOUSE_POINTER_ID, event.clientX, event.clientY);
  };

  const endMouse = () => {
    if (pointerEventsRecentlyHandled()) return;
    endGesture(MIRROR_MOUSE_POINTER_ID);
  };

  const wheelGesture = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (settling || !swipeEnabled || isPlayerInteractiveTarget(event.target) || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const wheel = wheelRef.current;
    window.clearTimeout(wheel.timer);
    wheel.timer = window.setTimeout(() => {
      if (!wheel.committed && wheel.offset !== 0) finishDrag(0);
      wheel.offset = 0;
      wheel.committed = false;
      wheel.timer = undefined;
    }, WHEEL_IDLE_MS);
    if (wheel.committed) return;
    const deltaScale = event.deltaMode === 1 ? 18 : event.deltaMode === 2
      ? stageRef.current?.getBoundingClientRect().height || window.innerHeight
      : 1;
    wheel.offset -= event.deltaY * deltaScale;
    const height = stageRef.current?.getBoundingClientRect().height || window.innerHeight;
    const threshold = Math.min(96, height * 0.12);
    scheduleDrag(Math.max(-height, Math.min(height, wheel.offset)));
    if (Math.abs(wheel.offset) < threshold) return;
    wheel.committed = true;
    finishDrag(wheel.offset < 0 ? -1 : 1);
  };

  const startTouch = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (touch) beginGesture(touch.identifier, touch.clientX, touch.clientY, event.target);
  };

  const moveTouch = (event: ReactTouchEvent<HTMLDivElement>) => {
    const id = dragRef.current?.id;
    if (id === undefined) return;
    const touch = Array.from(event.touches).find((item) => item.identifier === id);
    if (touch) moveGesture(id, touch.clientX, touch.clientY);
  };

  const endTouch = (event: ReactTouchEvent<HTMLDivElement>) => {
    const id = dragRef.current?.id;
    if (id === undefined) return;
    if (Array.from(event.changedTouches).some((item) => item.identifier === id)) endGesture(id);
  };

  const adjacentPoster = (episode: Episode | undefined, position: "previous" | "next") => {
    const url = episode?.posterUrl.trim() || fallbackPosterUrl?.trim() || "";
    return (
      <section className={`video-slider-item adjacent-slide ${position}`} data-episode-id={episode?.id} aria-hidden="true">
        {url && <img className="video-slider-poster" src={coverThumbnail(url, 720)} alt="" decoding="async" draggable={false} />}
      </section>
    );
  };

  return (
    <div
      ref={stageRef}
      className={`player-stage video-swiper${chromeVisible ? " chrome-visible" : ""}${speeding ? " is-speeding" : ""}`}
      data-testid="player-stage"
      onClick={(event) => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        onClick?.(event);
      }}
      onPointerDownCapture={startPointer}
      onPointerMoveCapture={movePointer}
      onPointerUpCapture={endPointer}
      onPointerCancelCapture={() => { stopHold(); finishDrag(0); }}
      onLostPointerCapture={(event) => endGesture(event.pointerId)}
      onMouseDownCapture={startMouse}
      onMouseMoveCapture={moveMouse}
      onMouseUpCapture={endMouse}
      onWheelCapture={wheelGesture}
      onTouchStartCapture={startTouch}
      onTouchMoveCapture={moveTouch}
      onTouchEndCapture={endTouch}
      onTouchCancelCapture={() => { stopHold(); finishDrag(0); }}
      onContextMenu={(event) => { if (holdRef.current?.active || suppressClickRef.current) event.preventDefault(); }}
    >
      <div
        ref={trackRef}
        className={`video-swiper-track${settling ? " is-settling" : ""}`}
      >
        {adjacentPoster(previousEpisode, "previous")}
        <SliderItem active distance={0} episode={currentEpisode} fallbackPosterUrl={fallbackPosterUrl} previewable hostRef={attachPlayerRoot}>
          {children}
        </SliderItem>
        {adjacentPoster(nextEpisode, "next")}
      </div>
    </div>
  );
}
