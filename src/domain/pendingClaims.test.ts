import { describe, expect, it, vi } from "vitest";

import type { MiniDramaApi, RewardClaim } from "./types";
import { PendingClaimStore, retryPendingClaims } from "./pendingClaims";

const claim: RewardClaim = {
  claimId: "claim-episode-00000001",
  offerId: "offer-episode-1",
  adUnitId: "reward-placement",
  dramaId: "drama-1",
  episodeId: "episode-3",
};

function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
}

describe("PendingClaimStore", () => {
  it("keeps the same completed-ad claim until the backend confirms settlement", async () => {
    const store = new PendingClaimStore(createStorage(), "app-one");
    store.add(claim);
    const api = {
      claimReward: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({
          claimId: claim.claimId,
          status: "already_granted",
          unlocked: true,
          dramaId: claim.dramaId,
          episodeId: claim.episodeId,
          rewardType: "episode_unlock",
        }),
    } as unknown as MiniDramaApi;

    await retryPendingClaims(api, store);
    expect(store.list()).toEqual([claim]);

    await retryPendingClaims(api, store);
    expect(api.claimReward).toHaveBeenNthCalledWith(2, claim);
    expect(store.list()).toEqual([]);
  });

  it("removes a deterministic server rejection instead of retrying forever", async () => {
    const store = new PendingClaimStore(createStorage(), "app-one");
    store.add(claim);
    const rejection = new Error("invalid reward claim");
    const api = {
      claimReward: vi.fn().mockRejectedValue(rejection),
    } as unknown as MiniDramaApi;

    const results = await retryPendingClaims(
      api,
      store,
      (error) => error !== rejection,
    );

    expect(results).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("restores a targetless VIP claim after a reload", () => {
    const storage = createStorage();
    const vipClaim: RewardClaim = {
      claimId: "claim-vip-00000001",
      offerId: "offer-vip-1",
      adUnitId: "vip-placement",
    };

    new PendingClaimStore(storage, "app-one").add(vipClaim);

    expect(new PendingClaimStore(storage, "app-one").list()).toEqual([vipClaim]);
  });

  it("isolates pending claims by application code", () => {
    const storage = createStorage();
    const firstApplication = new PendingClaimStore(storage, "app-one");
    const secondApplication = new PendingClaimStore(storage, "app-two");

    firstApplication.add(claim);

    expect(firstApplication.list()).toEqual([claim]);
    expect(secondApplication.list()).toEqual([]);
  });

  it("写入失败时同分区使用共享内存补领，读取恢复不能复活已确认记录", () => {
    const storage = createStorage();
    const store = new PendingClaimStore(storage, "app:A");
    store.add(claim);
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("blocked", "QuotaExceededError"); });
    store.remove(claim.claimId);
    const nextClaim = { ...claim, claimId: "claim-new" };
    store.add(nextClaim);
    expect(store.list()).toEqual([nextClaim]);
    expect(new PendingClaimStore(storage, "app:A").list()).toEqual([nextClaim]);
    expect(new PendingClaimStore(storage, "app:B").list()).toEqual([]);
    write.mockRestore();
    expect(store.list()).toEqual([nextClaim]);
    expect(JSON.parse(storage.getItem("tiktok_minis_pending_reward_claims:app:A")!)).toEqual([nextClaim]);
  });

  it("读取失败时保留当前广告，恢复时合并未知持久项且不覆盖其他主体", () => {
    const storage = createStorage();
    const existing = { ...claim, claimId: "existing" };
    storage.setItem("tiktok_minis_pending_reward_claims:app:A", JSON.stringify([existing]));
    storage.setItem("tiktok_minis_pending_reward_claims:app:B", JSON.stringify([claim]));
    const read = vi.spyOn(storage, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const store = new PendingClaimStore(storage, "app:A");
    store.add(claim);
    expect(store.list()).toEqual([claim]);
    store.remove(claim.claimId);
    expect(store.list()).toEqual([]);
    read.mockRestore();
    expect(store.list()).toEqual([existing]);
    expect(new PendingClaimStore(storage, "app:B").list()).toEqual([claim]);
  });

  it("内存模式也始终保留原ClaimID，补领成功后恢复存储不会再次发放", async () => {
    const storage = createStorage();
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("offline storage"); });
    const store = new PendingClaimStore(storage, "app:A");
    store.add(claim);
    const api = { claimReward: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ claimId: claim.claimId, status: "granted" }) };
    await retryPendingClaims(api, store);
    expect(store.list()).toEqual([claim]);
    await retryPendingClaims(api, store);
    expect(store.list()).toEqual([]);
    write.mockRestore();
    await retryPendingClaims(api, store);
    expect(api.claimReward).toHaveBeenCalledTimes(2);
    expect(api.claimReward).toHaveBeenNthCalledWith(2, claim);
    expect(JSON.parse(storage.getItem("tiktok_minis_pending_reward_claims:app:A")!)).toEqual([]);
  });

  it("逐条确认立即通知，不等待同批下一条请求返回", async () => {
    const store = new PendingClaimStore(createStorage(), "app:A");
    store.add(claim);
    store.add({ ...claim, claimId: "second" });
    let failSecond!: (reason: Error) => void;
    const result = { claimId: claim.claimId, status: "granted" };
    const api = { claimReward: vi.fn().mockResolvedValueOnce(result).mockImplementationOnce(() => new Promise((_resolve, reject) => { failSecond = reject; })) };
    const confirmed = vi.fn();
    const pending = retryPendingClaims(api, store, undefined, undefined, confirmed);
    await vi.waitFor(() => expect(api.claimReward).toHaveBeenCalledTimes(2));
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(result);
    failSecond(new Error("offline"));
    await pending;
    expect(store.list().map((item) => item.claimId)).toEqual(["second"]);
  });
});
