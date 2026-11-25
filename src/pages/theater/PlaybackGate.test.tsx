import type { ReactNode } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NextAdPrompt } from "../../domain/types";
import type { Runtime } from "../../runtime/runtime";
import { PlaybackGate } from "./PlaybackGate";
import { useAutoUnlock } from "./useAutoUnlock";

const target: NextAdPrompt = { dramaId: "1", episodeId: "2", episodeNumber: 2, unlockedCount: 1, totalCount: 3,
  offer: { kind: "rewarded_episode", offerId: "offer", adUnitId: "ad", autoUnlock: { enabled: true } } };

it.each([false, true].flatMap(preserveContent => ["放行", "离开"].map(outcome => ({ preserveContent, outcome }))))("保留视觉=$preserveContent，用户已确认下一条时遇到门禁重查，$outcome 后才决定是否继续广告", async ({ preserveContent, outcome }) => {
  const runtime = { showRewardedAd: vi.fn(async () => ({ status: "completed" })),
    claimReward: vi.fn(async () => ({ unlocked: true, nextAd: null })) } as unknown as Runtime;
  let allowed = true;
  const hook = renderHook(() => useAutoUnlock(runtime, "1:1"), {
    wrapper: ({ children }: { children: ReactNode }) => <PlaybackGate allowed={allowed} preserveContent={preserveContent} fallback={null}>{children}</PlaybackGate>,
  });
  let chain!: Promise<void>;
  act(() => { chain = hook.result.current.run(target, () => true, () => true, async () => false); });
  const decide = hook.result.current.prompt!.decide;
  allowed = false;
  hook.rerender();
  await act(async () => { decide(true); await Promise.resolve(); });
  expect(runtime.showRewardedAd).not.toHaveBeenCalled();
  expect(runtime.claimReward).not.toHaveBeenCalled();
  if (outcome === "放行") {
    allowed = true;
    hook.rerender();
    await act(async () => chain);
  } else {
    hook.unmount();
    await chain;
  }
  expect(runtime.showRewardedAd).toHaveBeenCalledTimes(outcome === "放行" ? 1 : 0);
  expect(runtime.claimReward).toHaveBeenCalledTimes(outcome === "放行" ? 1 : 0);
});

it("保留视觉不提前挂载未通过门禁的内容；真实拒绝仍隐藏内容并显示恢复页", () => {
  const view = (allowed: boolean, preserveContent: boolean) => <PlaybackGate allowed={allowed} preserveContent={preserveContent}
    fallback={<div data-testid="recovery" />}><div data-testid="content" /></PlaybackGate>;
  const mounted = render(view(false, true));
  expect(screen.queryByTestId("content")).toBeNull();
  expect(screen.getByTestId("recovery")).toBeVisible();
  mounted.rerender(view(true, false));
  const content = screen.getByTestId("content");
  mounted.rerender(view(false, true));
  expect(screen.getByTestId("content")).toBe(content);
  expect(content).toBeVisible();
  expect(screen.queryByTestId("recovery")).toBeNull();
  mounted.rerender(view(false, false));
  expect(content).not.toBeVisible();
  expect(screen.getByTestId("recovery")).toBeVisible();
});
