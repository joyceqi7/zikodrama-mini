import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IncompleteAdDialog } from "./IncompleteAdDialog";
import type { IncompleteAdPrompt } from "../pages/theater/useIncompleteAdPrompt";
import { text } from "../copy";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("强弹没有关闭入口，后台暂停且下一轮提示独立计时", async () => {
  vi.useFakeTimers();
  const first: IncompleteAdPrompt = { countdownSeconds: 3, decide: vi.fn() };
  const view = render(<IncompleteAdDialog prompt={first} visible />);
  const dialog = screen.getByRole("dialog", { name: text("player.resumeUnlockTitle") });
  expect(screen.queryByRole("button", { name: /not now|close/i })).not.toBeInTheDocument();
  fireEvent.click(dialog.parentElement!);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(first.decide).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds: 2 }))).toBeInTheDocument();
  view.rerender(<IncompleteAdDialog prompt={first} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(first.decide).not.toHaveBeenCalled();
  view.rerender(<IncompleteAdDialog prompt={first} visible />);
  for (let second = 0; second < 2; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  }
  expect(first.decide).toHaveBeenCalledOnce();
  expect(first.decide).toHaveBeenCalledWith(true);

  const second: IncompleteAdPrompt = { countdownSeconds: 5, decide: vi.fn() };
  view.rerender(<IncompleteAdDialog prompt={second} visible />);
  expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds: 5 }))).toBeInTheDocument();
  for (let second = 0; second < 4; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  }
  expect(second.decide).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(second.decide).toHaveBeenCalledOnce();
});

it("显示五秒在实际三秒内走到零，只有到零才重新拉起广告", async () => {
  vi.useFakeTimers();
  const prompt: IncompleteAdPrompt = { countdownSeconds: 3, displayCountdownSeconds: 5, decide: vi.fn() };
  render(<IncompleteAdDialog prompt={prompt} visible />);
  for (const seconds of [5, 4, 3, 2, 1]) {
    expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds }))).toBeInTheDocument();
    expect(prompt.decide).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  }
  expect(screen.getByText(text("player.resumeUnlockCountdown", { seconds: 0 }))).toBeInTheDocument();
  expect(prompt.decide).toHaveBeenCalledOnce();
  expect(prompt.decide).toHaveBeenCalledWith(true);
});
