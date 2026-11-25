import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlaybackProgressReporter } from "./playbackProgress";

const snapshot = (currentTime: number, duration = 60) => ({
  currentTime, duration, paused: false, ended: false,
});

describe("本地播放进度", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("周期写入离开时间回调并合并最新进度，暂停或退出同步保存不足五秒的部分", () => {
    const save = vi.fn();
    const reporter = new PlaybackProgressReporter(save);
    reporter.setTarget("drama-1", "episode-1");
    reporter.report(snapshot(4));
    expect(save).not.toHaveBeenCalled();
    reporter.report(snapshot(5));
    expect(save).not.toHaveBeenCalled();
    reporter.report(snapshot(8));
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ currentTime: 8 }));
    reporter.report(snapshot(11));
    // 调用返回时已经落地，不需要等待 Promise 或任务队列。
    expect(reporter.flush()).toBeUndefined();
    expect(save.mock.calls.map(([input]) => input.currentTime)).toEqual([8, 11]);
    reporter.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("宿主提供空闲回调时优先使用，并在切集前取消旧任务同步落盘", () => {
    let idleCallback: IdleRequestCallback | undefined;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => { idleCallback = callback; return 7; });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    try {
      const save = vi.fn();
      const reporter = new PlaybackProgressReporter(save);
      reporter.setTarget("drama-1", "episode-1");
      reporter.report(snapshot(5));
      reporter.report(snapshot(7));
      expect(requestIdleCallback).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      idleCallback?.({ didTimeout: false, timeRemaining: () => 10 });
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ currentTime: 7 }));
      reporter.report(snapshot(13));
      reporter.flush();
      expect(cancelIdleCallback).toHaveBeenCalledWith(7);
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ currentTime: 13 }));
    } finally { vi.unstubAllGlobals(); }
  });

  it("切集先保存旧集，再重置新集阈值；清除目标后忽略迟到事件", () => {
    const save = vi.fn();
    const reporter = new PlaybackProgressReporter(save);
    reporter.setTarget("drama-1", "episode-1");
    reporter.report(snapshot(3));
    reporter.flush();
    reporter.clearTarget();
    reporter.report(snapshot(10));
    reporter.setTarget("drama-1", "episode-2");
    reporter.report(snapshot(6, 70));
    vi.advanceTimersByTime(200);
    expect(save.mock.calls.map(([input]) => input)).toEqual([
      { dramaId: "drama-1", episodeId: "episode-1", currentTime: 3, duration: 60 },
      { dramaId: "drama-1", episodeId: "episode-2", currentTime: 6, duration: 70 },
    ]);
  });

  it("向后拖动进度仍会保存，暂停时同步补写", () => {
    const save = vi.fn();
    const reporter = new PlaybackProgressReporter(save);
    reporter.setTarget("drama-1", "episode-1");
    reporter.report(snapshot(20));
    vi.advanceTimersByTime(200);
    reporter.report(snapshot(5));
    vi.advanceTimersByTime(200);
    expect(save.mock.calls.map(([input]) => input.currentTime)).toEqual([20, 5]);
    reporter.report(snapshot(0));
    reporter.flush();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ currentTime: 0 }));
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("存储异常不阻断播放，也不把失败进度标为已保存", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const save = vi.fn().mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    const reporter = new PlaybackProgressReporter(save);
    reporter.setTarget("drama-1", "episode-1");
    expect(() => reporter.report(snapshot(6))).not.toThrow();
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "local_playback_progress_save_failed", error: "storage unavailable",
    }));
    reporter.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ currentTime: 6 }));
    warning.mockRestore();
  });

  it("结束事件写最终快照，随后的卸载不重新写回旧时间更新", () => {
    const save = vi.fn();
    const reporter = new PlaybackProgressReporter(save);
    reporter.setTarget("drama-1", "episode-1");
    reporter.report(snapshot(55));
    reporter.flush({ ...snapshot(60), ended: true });
    reporter.flush();
    vi.advanceTimersByTime(200);
    expect(save.mock.calls.map(([input]) => input.currentTime)).toEqual([60]);
  });
});
