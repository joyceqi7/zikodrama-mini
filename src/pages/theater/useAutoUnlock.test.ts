import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { NextAdPrompt } from "../../domain/types";
import type { Runtime } from "../../runtime/runtime";
import { useAutoUnlock } from "./useAutoUnlock";

const target: NextAdPrompt = { dramaId: "1", episodeId: "9", episodeNumber: 9, unlockedCount: 8, totalCount: 10,
  offer: { kind: "rewarded_episode", offerId: "offer", adUnitId: "ad", autoUnlock: { enabled: true, countdownSeconds: 3 } } };
function setup(status = "completed") {
  const runtime = { api: { drama: vi.fn(), resolvePlay: vi.fn(), resolvePlayBatch: vi.fn() },
    showRewardedAd: vi.fn(async () => ({ status })), claimReward: vi.fn(async () => ({ unlocked: true, nextAd: null })) } as unknown as Runtime;
  return { runtime, hook: renderHook(() => useAutoUnlock(runtime, "1:1")) };
}
it.each([undefined, null])("服务端未返回下一步 %s 时直接结束，不扫描目录", async next => {
  const { runtime, hook } = setup();
  await act(async () => { await hook.result.current.run(next, () => true, () => true, async () => false); });
  expect(hook.result.current.prompt).toBeUndefined();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
  expect(runtime.api.resolvePlayBatch).not.toHaveBeenCalled();
  expect(runtime.api.drama).not.toHaveBeenCalled();
});
it("立即显示服务端指定目标，取消不发广告且不追加查询", async () => {
  const { runtime, hook } = setup(); let running!: Promise<void>;
  act(() => { running = hook.result.current.run(target, () => true, () => true, async () => false); });
  expect(hook.result.current.prompt).toMatchObject({ episodeNumber: 9, unlockedCount: 8 });
  await act(async () => { hook.result.current.prompt!.decide(false); await running; });
  expect(runtime.showRewardedAd).not.toHaveBeenCalled();
  expect(runtime.api.resolvePlay).not.toHaveBeenCalled();
});
it.each(["completed", "cancelled"])("广告 %s 后只消费新结算决策，未完成不领奖", async status => {
  const { runtime, hook } = setup(status); let running!: Promise<void>;
  act(() => { running = hook.result.current.run(target, () => true, () => true, async () => false); });
  await act(async () => { hook.result.current.prompt!.decide(true); await running; });
  expect(runtime.claimReward).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
  expect(hook.result.current.prompt).toBeUndefined();
  expect(runtime.api.resolvePlayBatch).not.toHaveBeenCalled();
});
it("卸载结束待决定提示，不继续拉广告", async () => {
  const { runtime, hook } = setup(); let running!: Promise<void>;
  act(() => { running = hook.result.current.run(target, () => true, () => true, async () => false); });
  hook.unmount(); await running;
  expect(runtime.showRewardedAd).not.toHaveBeenCalled();
});

it("重复启动和连续点击只触发一次广告及领取", async () => {
  const { runtime, hook } = setup(); let running!: Promise<void>;
  act(() => { running = hook.result.current.run(target, () => true, () => true, async () => false); });
  const decide = hook.result.current.prompt!.decide;
  await act(async () => {
    await hook.result.current.run(target, () => true, () => true, async () => false);
    decide(true); decide(true); decide(false);
    await running;
  });
  expect(runtime.showRewardedAd).toHaveBeenCalledTimes(1);
  expect(runtime.claimReward).toHaveBeenCalledTimes(1);
});
