import type { Id } from "./id";
import type { AccessOffer, RewardClaim } from "./types";

// createRewardClaim 在展示广告前生成稳定幂等键。只有 TikTok 返回 isEnded=true 后，这个
// 对象才会提交并写入 PendingClaimStore；网络重试始终复用同一个 claimId。
export function createRewardClaim(
  offer: AccessOffer,
  dramaId?: Id,
  episodeId?: Id,
): RewardClaim {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const claimId = `claim_${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
  return {
    claimId,
    offerId: offer.offerId,
    adUnitId: offer.adUnitId,
    ...(dramaId ? { dramaId } : {}),
    ...(episodeId ? { episodeId } : {}),
  };
}
