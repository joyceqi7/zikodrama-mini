import type { EntryAdStatus } from "./types";

/** entryAdCount 由 Mini 选择达标计数，展示模式仅使用成功展示事实。 */
export function entryAdCount(status: EntryAdStatus): number {
  return status.countBy === "shown" ? status.shownCount ?? 0 : status.completedCount;
}
