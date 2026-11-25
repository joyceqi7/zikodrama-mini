import type { ClaimResult, MiniDramaApi, RewardClaim } from "./types";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import { browserStorage } from "./browserStorage";

const STORAGE_KEY = "tiktok_minis_pending_reward_claims";

/** PendingPartition 在当前 WebView 共享同一主体的内存副本，存储异常不丢失已完成广告。 */
interface PendingPartition {
  /** claims 是合并了尚未持久化增删操作的当前权威视图。 */
  claims: Map<string, RewardClaim>;
  /** changes 中 null 表示已确认结算的删除标记，禁止旧 Storage 记录复活。 */
  changes: Map<string, RewardClaim | null>;
  /** memoryOnly 标识持久化暂不可用，日志只能承诺当前页面内可补领。 */
  memoryOnly: boolean;
}

// WeakMap 不跨 Storage/页面共享身份；分区键始终含应用与服务端 Visitor。
const partitions = new WeakMap<Storage, Map<string, PendingPartition>>();

function toRewardClaim(value: unknown): RewardClaim | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RewardClaim>;
  if (
    ![candidate.claimId, candidate.offerId, candidate.adUnitId].every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    return undefined;
  }
  const claimId = candidate.claimId;
  const offerId = candidate.offerId;
  const adUnitId = candidate.adUnitId;
  if (!claimId || !offerId || !adUnitId) return undefined;
  if (
    candidate.dramaId !== undefined &&
    typeof candidate.dramaId !== "string"
  ) {
    return undefined;
  }
  if (
    candidate.episodeId !== undefined &&
    typeof candidate.episodeId !== "string"
  ) {
    return undefined;
  }
  return {
    claimId,
    offerId,
    adUnitId,
    ...(candidate.dramaId ? { dramaId: candidate.dramaId } : {}),
    ...(candidate.episodeId ? { episodeId: candidate.episodeId } : {}),
  };
}

// PendingClaimStore 只保存 TikTok 已经完整播放、但服务端结果尚未确认的领取请求。
// 它不保存广告展示尝试或过期凭据；记录会在服务端幂等确认成功或明确拒绝后删除。
export class PendingClaimStore {
  /** partition 使同一账号重建 Store 或切回账号时仍能读取内存中未结算记录。 */
  private readonly partition: PendingPartition;

  constructor(
    private readonly storage: Storage = browserStorage(),
    private readonly applicationCode: string,
  ) {
    if (!applicationCode.trim()) throw new Error("applicationCode is required");
    let byKey = partitions.get(storage);
    if (!byKey) {
      byKey = new Map();
      partitions.set(storage, byKey);
    }
    let partition = byKey.get(this.storageKey);
    if (!partition) {
      partition = { claims: new Map(), changes: new Map(), memoryOnly: false };
      byKey.set(this.storageKey, partition);
    }
    this.partition = partition;
  }

  private get storageKey(): string {
    return `${STORAGE_KEY}:${this.applicationCode}`;
  }

  /** list 返回隔离副本；存储恢复时先合并本地增删再持久化，不能直接采信旧快照。 */
  list(): RewardClaim[] {
    this.synchronize();
    return [...this.partition.claims.values()].map((claim) => ({ ...claim }));
  }

  /** add 在请求结算前先写内存，Storage 抛错不会丢失同一 ClaimID。 */
  add(claim: RewardClaim): void {
    this.synchronize();
    const snapshot = { ...claim };
    this.partition.claims.set(claim.claimId, snapshot);
    this.partition.changes.set(claim.claimId, snapshot);
    this.synchronize();
  }

  /** remove 用删除标记覆盖未落盘的旧记录，恢复持久化后也不得重新补领。 */
  remove(claimId: string): void {
    this.synchronize();
    this.partition.claims.delete(claimId);
    this.partition.changes.set(claimId, null);
    this.synchronize();
  }

  /** synchronize 只有成功读取原分区后才写回，避免读故障时覆盖未知的历史待领项。 */
  private synchronize(): void {
    try {
      const parsed: unknown = JSON.parse(
        this.storage.getItem(this.storageKey) || "[]",
      );
      const persisted = Array.isArray(parsed)
        ? parsed
            .map(toRewardClaim)
            .filter((item): item is RewardClaim => Boolean(item))
        : [];
      const merged = new Map(persisted.map((claim) => [claim.claimId, claim]));
      for (const [claimId, claim] of this.partition.changes) {
        if (claim) merged.set(claimId, claim);
        else merged.delete(claimId);
      }
      this.partition.claims = merged;
      if (this.partition.changes.size > 0) {
        this.storage.setItem(this.storageKey, JSON.stringify([...merged.values()]));
        this.partition.changes.clear();
      }
      if (this.partition.memoryOnly) {
        logClientEvent("info", "pending_claim_storage_restored", {
          flow: "reward_claim", stage: "pending_storage", outcome: "persistent_storage_available",
        });
        this.partition.memoryOnly = false;
      }
    } catch (reason) {
      if (!this.partition.memoryOnly) {
        logClientEvent("warn", "pending_claim_storage_unavailable", {
          error: safeErrorMessage(reason),
          flow: "reward_claim", stage: "pending_storage", outcome: "memory_only_until_page_exit",
        });
        this.partition.memoryOnly = true;
      }
    }
  }
}

/** retryPendingClaims 只操作传入的账号分区；身份变化时立即停止本批次，不转发后续记录。 */
export async function retryPendingClaims(
  api: Pick<MiniDramaApi, "claimReward">,
  store: PendingClaimStore,
  shouldRetry: (error: unknown) => boolean = () => true,
  shouldContinue: (error?: unknown) => boolean = () => true,
  // 每条确认后立即通知，不让后续超时的领取拖延当前已解锁剧集的播放。
  onConfirmed?: (claim: ClaimResult) => void,
): Promise<ClaimResult[]> {
  const claimed: ClaimResult[] = [];
  for (const claim of store.list()) {
    if (!shouldContinue()) break;
    let result: ClaimResult;
    try {
      result = await api.claimReward(claim);
      store.remove(claim.claimId);
    } catch (error) {
      logClientEvent("warn", "pending_claim_retry_failed", { error: safeErrorMessage(error) });
      // 账号切换不是业务拒绝，原分区当前记录和后续记录都必须保留。
      if (!shouldContinue(error)) break;
      if (shouldRetry(error)) {
        // 服务端可能已经提交结算但响应丢失，保留同一个 ClaimID 再次查询结果。
        continue;
      }
      store.remove(claim.claimId);
      continue;
    }
    claimed.push(result);
    onConfirmed?.(result);
  }
  return claimed;
}
