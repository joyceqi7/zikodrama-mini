import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Episode } from "../../domain/types";
import { VideoSwiper } from ".";
import { isPlayerInteractiveTarget } from "./gesture";

const episodeList: Episode[] = [1, 2, 3].map((number) => ({
  id: `episode-${number}`,
  dramaId: "drama-1",
  number,
  title: `Episode ${number}`,
  description: "",
  posterUrl: `https://img.example/${number}.jpg`,
  durationSeconds: 60,
  accessMode: "free",
}));

describe("VideoSwiper", () => {
  it("视频手势阻止原生滚动，交互区仍可滚动且卸载后解除监听", () => {
    const view = render(<VideoSwiper activeEpisodeId="episode-1" chromeVisible episodes={episodeList}
      onEpisodeChange={vi.fn()} playerRootRef={{ current: null }} swipeEnabled={false}>
      <div data-player-interactive="true" data-testid="scrollable">选集</div>
    </VideoSwiper>);
    const stage = screen.getByTestId("player-stage");
    for (const type of ["wheel", "touchmove"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      stage.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const interactiveEvent = new Event(type, { bubbles: true, cancelable: true });
      screen.getByTestId("scrollable").dispatchEvent(interactiveEvent);
      expect(interactiveEvent.defaultPrevented).toBe(false);
    }
    view.unmount();
    const detachedEvent = new Event("wheel", { cancelable: true });
    stage.dispatchEvent(detachedEvent);
    expect(detachedEvent.defaultPrevented).toBe(false);
  });
  it("长按画面临时加速，松开恢复；滑动与控件按压不触发", () => {
    vi.useFakeTimers();
    try {
      const onLongPressStart = vi.fn();
      const onLongPressEnd = vi.fn();
      const onClick = vi.fn();
      const view = render(<VideoSwiper activeEpisodeId="episode-1" chromeVisible episodes={episodeList}
        onEpisodeChange={vi.fn()} playerRootRef={{ current: null }} swipeEnabled longPressEnabled
        onLongPressStart={onLongPressStart} onLongPressEnd={onLongPressEnd} onClick={onClick}>
        <button type="button">control</button>
      </VideoSwiper>);
      const stage = screen.getByTestId("player-stage");
      const pointer = (target: HTMLElement | Window, type: "pointerdown" | "pointermove" | "pointerup", id: number, y: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: y });
        Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } });
        fireEvent(target, event);
      };
      pointer(stage, "pointerdown", 1, 100);
      act(() => vi.advanceTimersByTime(350));
      expect(onLongPressStart).toHaveBeenCalledOnce();
      pointer(stage, "pointermove", 1, 120);
      expect(onLongPressEnd).not.toHaveBeenCalled();
      pointer(window, "pointerup", 1, 100);
      expect(onLongPressEnd).toHaveBeenCalledOnce();
      fireEvent.click(stage);
      expect(onClick).not.toHaveBeenCalled();
      pointer(stage, "pointerdown", 2, 100);
      pointer(stage, "pointermove", 2, 130);
      act(() => vi.advanceTimersByTime(350));
      expect(onLongPressStart).toHaveBeenCalledOnce();
      pointer(screen.getByRole("button", { name: "control" }), "pointerdown", 3, 100);
      act(() => vi.advanceTimersByTime(350));
      expect(onLongPressStart).toHaveBeenCalledOnce();
      view.unmount();
    } finally { vi.useRealTimers(); }
  });
  it("识别 VePlayer 官方交互区但不吞掉整个视频画面", () => {
    const playerRoot = document.createElement("div");
    playerRoot.className = "xgplayer";
    const controls = document.createElement("div");
    controls.className = "xgplayer-controls";
    const progress = document.createElement("div");
    progress.className = "xgplayer-progress";
    controls.appendChild(progress);
    playerRoot.appendChild(controls);

    expect(isPlayerInteractiveTarget(progress)).toBe(true);
    expect(isPlayerInteractiveTarget(playerRoot)).toBe(false);
  });

  it("只有授权就绪后才响应上下拖动", () => {
    vi.useFakeTimers();
    const props = { activeEpisodeId: "episode-1", chromeVisible: true, episodes: episodeList,
      onEpisodeChange: vi.fn(), playerRootRef: { current: null } };
    const view = render(<VideoSwiper {...props} swipeEnabled={false}>overlay</VideoSwiper>);
    const stage = screen.getByTestId("player-stage");
    const pointer = (type: "pointerdown" | "pointermove" | "pointerup", y: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "touch" } });
      fireEvent(stage, event);
    };
    pointer("pointerdown", 500); pointer("pointermove", 280); pointer("pointerup", 280);
    expect(props.onEpisodeChange).not.toHaveBeenCalled();
    view.rerender(<VideoSwiper {...props} swipeEnabled>overlay</VideoSwiper>);
    pointer("pointerdown", 500); pointer("pointermove", 280); pointer("pointerup", 280);
    expect(props.onEpisodeChange).toHaveBeenCalledExactlyOnceWith("episode-2");
    act(() => vi.advanceTimersByTime(260));
    vi.useRealTimers();
  });

  it("切集时播放器根节点和承载容器都保持不变", () => {
    const playerRootRef: { current: HTMLDivElement | null } = { current: null };
    const props = {
      chromeVisible: true,
      episodes: episodeList,
      onEpisodeChange: vi.fn(),
      playerRootRef,
      swipeEnabled: true,
    };
    const view = render(
      <StrictMode>
        <VideoSwiper {...props} activeEpisodeId="episode-1">
          <span>overlay</span>
        </VideoSwiper>
      </StrictMode>,
    );

    const playerRoot = playerRootRef.current;
    expect(playerRoot).not.toBeNull();
    expect(playerRoot?.parentElement).toHaveAttribute("data-player-host", "episode-1");
    const stableHost = playerRoot?.parentElement;
    const remove = vi.spyOn(playerRoot!, "remove");

    view.rerender(
      <StrictMode>
        <VideoSwiper {...props} activeEpisodeId="episode-2">
          <span>overlay</span>
        </VideoSwiper>
      </StrictMode>,
    );

    expect(playerRootRef.current).toBe(playerRoot);
    expect(playerRoot?.parentElement).toBe(stableHost);
    expect(playerRoot?.parentElement).toHaveAttribute("data-player-host", "episode-2");
    expect(remove).not.toHaveBeenCalled();
    view.unmount();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("分集异步到达且路由不变时接回播放器节点与已挂载内核", () => {
    const playerRootRef: { current: HTMLDivElement | null } = { current: null };
    const props = { activeEpisodeId: "episode-1", chromeVisible: true, onEpisodeChange: vi.fn(), playerRootRef, swipeEnabled: true };
    const view = render(<StrictMode><VideoSwiper {...props} episodes={[]}>加载中</VideoSwiper></StrictMode>);
    const root = playerRootRef.current!;
    const host = root.parentElement;
    const kernel = document.createElement("video");
    root.appendChild(kernel);
    view.rerender(<StrictMode><VideoSwiper {...props} episodes={episodeList}>已就绪</VideoSwiper></StrictMode>);
    expect(playerRootRef.current).toBe(root);
    expect(root.parentElement).toHaveAttribute("data-player-host", "episode-1");
    expect(root.parentElement).toBe(host);
    expect(root.isConnected).toBe(true);
    expect(root.firstChild).toBe(kernel);
  });

  it("只为上下集渲染预览图，当前集画面由官方播放器接管", () => {
    render(
      <VideoSwiper
        activeEpisodeId="episode-2"
        chromeVisible
        episodes={episodeList}
        onEpisodeChange={vi.fn()}
        playerRootRef={{ current: null }}
        previewableEpisodeIds={new Set(episodeList.map((episode) => episode.id))}
        swipeEnabled
      >
        <span>overlay</span>
      </VideoSwiper>,
    );

    expect(document.querySelector('[data-episode-id="episode-1"] .video-slider-poster')).toHaveAttribute("src", "https://img.example/1.jpg");
    expect(document.querySelector('[data-episode-id="episode-2"] .video-slider-poster')).not.toBeInTheDocument();
    expect(document.querySelector('[data-episode-id="episode-3"] .video-slider-poster')).toHaveAttribute("src", "https://img.example/3.jpg");
  });

  it("相邻集海报不依赖短期播放权限", () => {
    render(
      <VideoSwiper
        activeEpisodeId="episode-2"
        chromeVisible
        episodes={episodeList}
        onEpisodeChange={vi.fn()}
        playerRootRef={{ current: null }}
        previewableEpisodeIds={new Set(["episode-1", "episode-2"])}
        swipeEnabled
      >
        <span>overlay</span>
      </VideoSwiper>,
    );

    expect(document.querySelector('[data-episode-id="episode-1"] .video-slider-poster')).toBeInTheDocument();
    expect(document.querySelector('[data-episode-id="episode-3"] .video-slider-poster')).toBeInTheDocument();
  });

  it("相邻集没有独立剧集图时使用短剧封面", () => {
    const episodes = episodeList.map((episode) =>
      episode.id === "episode-2" ? { ...episode, posterUrl: "" } : episode);
    render(
      <VideoSwiper
        activeEpisodeId="episode-1"
        chromeVisible
        episodes={episodes}
        fallbackPosterUrl="https://img.example/drama.jpg"
        onEpisodeChange={vi.fn()}
        playerRootRef={{ current: null }}
        previewableEpisodeIds={new Set(episodes.map((episode) => episode.id))}
        swipeEnabled
      >
        <span>overlay</span>
      </VideoSwiper>,
    );

    expect(document.querySelector('[data-episode-id="episode-2"] .video-slider-poster')).toHaveAttribute("src", "https://img.example/drama.jpg");
  });

  it("手势越过阈值后立即请求相邻分集", () => {
    vi.useFakeTimers();
    const onEpisodeChange = vi.fn();
    render(
      <VideoSwiper
        activeEpisodeId="episode-1"
        chromeVisible
        episodes={episodeList}
        onEpisodeChange={onEpisodeChange}
        playerRootRef={{ current: null }}
        swipeEnabled
      >
        <span>overlay</span>
      </VideoSwiper>,
    );

    const stage = screen.getByTestId("player-stage");
    const pointer = (type: "pointerdown" | "pointermove" | "pointerup", y: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 9 }, pointerType: { value: "touch" } });
      fireEvent(stage, event);
    };
    pointer("pointerdown", 500); pointer("pointermove", 300); pointer("pointerup", 300);
    expect(onEpisodeChange).toHaveBeenCalledWith("episode-2");
    expect(onEpisodeChange).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(260));
    vi.useRealTimers();
  });

  it("拖动帧直接更新轨道位移，结算后复位并保持播放器节点", () => {
    vi.useFakeTimers();
    try {
      const playerRootRef: { current: HTMLDivElement | null } = { current: null };
      const onEpisodeChange = vi.fn();
      const view = render(<VideoSwiper activeEpisodeId="episode-1" chromeVisible episodes={episodeList}
        onEpisodeChange={onEpisodeChange} playerRootRef={playerRootRef} swipeEnabled>画面</VideoSwiper>);
      const stage = screen.getByTestId("player-stage");
      const track = stage.querySelector<HTMLElement>(".video-swiper-track")!;
      const playerRoot = playerRootRef.current;
      const pointer = (type: "pointerdown" | "pointermove" | "pointerup", y: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX: 100, clientY: y });
        Object.defineProperties(event, { pointerId: { value: 19 }, pointerType: { value: "touch" } });
        fireEvent(stage, event);
      };
      pointer("pointerdown", 500);
      pointer("pointermove", 430);
      act(() => vi.advanceTimersByTime(20));
      expect(track.style.transform).toBe("translate3d(0, calc(-100% + -70px), 0)");
      expect(onEpisodeChange).not.toHaveBeenCalled();
      pointer("pointerup", 430);
      expect(track).toHaveClass("is-settling");
      act(() => vi.advanceTimersByTime(260));
      expect(track).not.toHaveClass("is-settling");
      expect(track.style.transform).toBe("translate3d(0, calc(-100% + 0px), 0)");
      expect(playerRootRef.current).toBe(playerRoot);
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("iPhone WebView 的 Touch 事件可以上下切集", () => {
    vi.useFakeTimers();
    const onEpisodeChange = vi.fn();
    render(
      <VideoSwiper activeEpisodeId="episode-1" chromeVisible episodes={episodeList}
        onEpisodeChange={onEpisodeChange} playerRootRef={{ current: null }} swipeEnabled>
        <span>overlay</span>
      </VideoSwiper>,
    );
    const stage = screen.getByTestId("player-stage");
    const touch = (type: "touchstart" | "touchmove" | "touchend", y: number) => {
      const point = { identifier: 17, clientX: 100, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : [point] },
        changedTouches: { value: [point] },
      });
      fireEvent(stage, event);
    };
    touch("touchstart", 520); touch("touchmove", 300); touch("touchend", 300);
    expect(onEpisodeChange).toHaveBeenCalledExactlyOnceWith("episode-2");
    act(() => vi.advanceTimersByTime(260));
    vi.useRealTimers();
  });

  it("手机镜像的鼠标拖动和触控板滚动都可以上下切集", () => {
    vi.useFakeTimers();
    try {
      const onEpisodeChange = vi.fn();
      const view = render(
        <VideoSwiper activeEpisodeId="episode-1" chromeVisible episodes={episodeList}
          onEpisodeChange={onEpisodeChange} playerRootRef={{ current: null }} swipeEnabled>
          <span>overlay</span>
        </VideoSwiper>,
      );
      const stage = screen.getByTestId("player-stage");
      fireEvent.mouseDown(stage, { button: 0, buttons: 1, clientX: 100, clientY: 520 });
      fireEvent.mouseMove(stage, { buttons: 1, clientX: 100, clientY: 300 });
      fireEvent.mouseUp(stage, { button: 0, clientX: 100, clientY: 300 });
      expect(onEpisodeChange).toHaveBeenCalledExactlyOnceWith("episode-2");
      act(() => vi.advanceTimersByTime(260));

      onEpisodeChange.mockClear();
      view.rerender(
        <VideoSwiper activeEpisodeId="episode-1" chromeVisible episodes={episodeList}
          onEpisodeChange={onEpisodeChange} playerRootRef={{ current: null }} swipeEnabled>
          <span>overlay</span>
        </VideoSwiper>,
      );
      fireEvent.wheel(stage, { deltaX: 0, deltaY: 120, deltaMode: 0 });
      expect(onEpisodeChange).toHaveBeenCalledExactlyOnceWith("episode-2");
      act(() => vi.advanceTimersByTime(260));
    } finally { vi.useRealTimers(); }
  });

  it("操作 VePlayer 官方控制栏时不触发上下滑切集", () => {
    const onEpisodeChange = vi.fn();
    const onClick = vi.fn();
    const playerRootRef: { current: HTMLDivElement | null } = { current: null };
    render(
      <VideoSwiper
        activeEpisodeId="episode-1"
        chromeVisible
        episodes={episodeList}
        onClick={onClick}
        onEpisodeChange={onEpisodeChange}
        playerRootRef={playerRootRef}
        swipeEnabled
      >
        <span>overlay</span>
      </VideoSwiper>,
    );

    const controls = document.createElement("div");
    controls.className = "xgplayer-controls";
    const progress = document.createElement("div");
    progress.className = "xgplayer-progress";
    controls.appendChild(progress);
    playerRootRef.current?.appendChild(controls);

    const pointerEvent = (
      type: "pointerdown" | "pointerup",
      clientY: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: 100,
        clientY,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: "touch" },
      });
      fireEvent(progress, event);
    };

    pointerEvent("pointerdown", 500);
    pointerEvent("pointerup", 360);
    fireEvent.click(progress);

    expect(onEpisodeChange).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
