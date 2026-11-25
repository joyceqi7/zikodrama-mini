import type { AdShow } from "./types";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

interface Partition {
  /** shows 保存原事件与内容来源，Storage 故障时保留内存副本。 */
  shows: Map<string, AdShow>;
  /** changes 合并未落盘的新增与删除，存储恢复后不会复活已确认事件。 */
  changes: Map<string, AdShow | null>;
}
const partitions = new WeakMap<Storage, Map<string, Partition>>();
const clone = (show: AdShow): AdShow => ({ ...show });

/** PendingAdShowStore 保存跨场景的成功展示事实，按应用和用户隔离。 */
export class PendingAdShowStore {
  private readonly key: string;
  private readonly partition: Partition;
  private failed = false;

  /** constructor 使用运行时安装的可信应用用户分区，页面内重建共享待确认状态。 */
  constructor(private readonly storage: Storage, subject: string, private readonly serverNow: () => number | undefined = () => undefined) {
    this.key = `tiktok_minis_pending_ad_shows:${subject}`;
    let group = partitions.get(storage);
    if (!group) { group = new Map(); partitions.set(storage, group); }
    let partition = group.get(this.key);
    if (!partition) { partition = { shows: new Map(), changes: new Map() }; group.set(this.key, partition); }
    this.partition = partition;
  }

  /** list 返回事实副本，外部修改不能改变后续补报。 */
  list(): AdShow[] {
    this.sync();
    const now = this.serverNow();
    if (now !== undefined) {
      for (const [id, show] of this.partition.shows) {
        if (show.queuedAtServer === undefined) this.partition.changes.set(id, { ...show, queuedAtServer: now });
        else if (now - show.queuedAtServer >= 48 * 60 * 60 * 1000) {
          this.partition.changes.set(id, null);
          logClientEvent("warn", "ad_show_expired", { error: "Ad display exceeded its pending retention window" });
        }
      }
      if (this.partition.changes.size) this.sync();
    }
    return [...this.partition.shows.values()].map(clone);
  }

  /** add 在发送前保存成功展示的原键、时间及来源，补报不创建第二个事件。 */
  add(show: AdShow): void {
    this.sync();
    const previous = this.partition.shows.get(show.eventId);
    const queuedAtServer = previous?.queuedAtServer ?? show.queuedAtServer ?? this.serverNow();
    this.partition.changes.set(show.eventId, { ...clone(show), ...(queuedAtServer === undefined ? {} : { queuedAtServer }) });
    this.sync();
  }

  /** remove 在服务端确认或永久拒绝后删除，并在 Storage 故障期间保留删除标记。 */
  remove(eventId: string): void { this.partition.changes.set(eventId, null); this.sync(); }

  private sync(): void {
    const applyChanges = (shows: Map<string, AdShow>) => {
      for (const [id, show] of this.partition.changes) { if (show) shows.set(id, show); else shows.delete(id); }
    };
    applyChanges(this.partition.shows);
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(this.key) || "[]");
      const stored = Array.isArray(parsed) ? parsed.filter((show): show is AdShow => !!show && typeof show === "object" &&
        [show.eventId, show.scene, show.adUnitId].every(value => typeof value === "string" && value.length > 0) &&
        (show.occurredAt === undefined || (typeof show.occurredAt === "string" && Number.isFinite(Date.parse(show.occurredAt)))) &&
        (show.queuedAtServer === undefined || (typeof show.queuedAtServer === "number" && Number.isFinite(show.queuedAtServer))) &&
        [show.dramaId, show.episodeId].every(value => value === undefined || typeof value === "string") && (!show.episodeId || !!show.dramaId)) : [];
      const merged = new Map(stored.map(show => [show.eventId, show]));
      applyChanges(merged);
      this.partition.shows = merged;
      if (this.partition.changes.size) {
        this.storage.setItem(this.key, JSON.stringify([...merged.values()]));
        this.partition.changes.clear();
      }
      this.failed = false;
    } catch (reason) {
      if (!this.failed) logClientEvent("warn", "ad_show_storage_failed", { error: safeErrorMessage(reason) });
      this.failed = true;
    }
  }
}
