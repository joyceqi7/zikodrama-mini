import type { DramaSummary } from "./types";

/** parseDramaSummary 校验并复制公开摘要白名单；丢弃详情中的分集、媒资和权益字段。 */
export function parseDramaSummary(value: unknown): DramaSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const keys = ["id", "firstEpisodeId", "title", "description", "coverUrl"] as const;
  if ((item.firstEpisodePosterUrl !== undefined && (typeof item.firstEpisodePosterUrl !== "string" || item.firstEpisodePosterUrl.length > 8192)) || keys.some(key => typeof item[key] !== "string" || (item[key] as string).length > 8192) ||
      !(item.id as string).trim() || (item.status !== "ongoing" && item.status !== "completed") ||
      !Number.isSafeInteger(item.episodeCount) || (item.episodeCount as number) < 0 ||
      !Array.isArray(item.tags) || item.tags.length > 100 ||
      item.tags.some(tag => typeof tag !== "string" || tag.length > 256)) return undefined;
  return {
    id: (item.id as string).trim(), firstEpisodeId: item.firstEpisodeId as string,
    ...(item.firstEpisodePosterUrl === undefined ? {} : { firstEpisodePosterUrl: item.firstEpisodePosterUrl as string }),
    title: item.title as string, description: item.description as string, coverUrl: item.coverUrl as string,
    status: item.status, episodeCount: item.episodeCount as number, tags: [...item.tags] as string[],
  };
}
