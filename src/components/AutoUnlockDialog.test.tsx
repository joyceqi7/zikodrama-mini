import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoUnlockDialog } from "./AutoUnlockDialog";
import type { AutoUnlockPrompt } from "../pages/theater/useAutoUnlock";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("新一轮提示使用自己的倒计时，后台暂停，上一轮归零不触发新广告", async () => {
  vi.useFakeTimers();
  const first: AutoUnlockPrompt = { config: { enabled: true, countdownSeconds: 1 }, episodeNumber: 2, unlockedCount: 1, totalCount: 3, decide: vi.fn() };
  const view = render(<AutoUnlockDialog prompt={first} visible />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(first.decide).toHaveBeenCalledOnce();
  const second = { ...first, config: { enabled: true, countdownSeconds: 5 }, episodeNumber: 3, decide: vi.fn() };
  view.rerender(<AutoUnlockDialog prompt={second} visible={false} />);
  expect(screen.getByText("5s")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(second.decide).not.toHaveBeenCalled();
  view.rerender(<AutoUnlockDialog prompt={second} visible />);
  for (let second = 0; second < 4; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  }
  expect(second.decide).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(second.decide).toHaveBeenCalledOnce();
});
