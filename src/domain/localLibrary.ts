import type { Id } from "./id";
import { browserStorage } from "./browserStorage";
import { parseDramaSummary } from "./dramaSummary";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import type {
  ContinueWatchingItem,
  DramaSummary,
  FollowedDrama,
} from "./types";

const STORAGE_KEY_PREFIX = "drama.local-library.v2:";
const MAX_HISTORY_ITEMS = 100;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** LocalFollowRecord 仅保存当前主体的本地收藏标识与时间。 */
export interface LocalFollowRecord {
  /** dramaId 是业务剧目字符串标识。 */
  dramaId: Id;
  /** createdAt 是本机收藏时间。 */
  createdAt: string;
}

/** LocalHistoryRecord 保存逐集续播位置，不代表播放权益。 */
export interface LocalHistoryRecord {
  /** drama 仅缓存历史展示摘要；旧记录可缺省，不代表当前可见性或播放权益。 */
  drama?: DramaSummary;
  /** dramaId 是业务剧目标识。 */
  dramaId: Id;
  /** episodeId 是业务分集标识。 */
  episodeId: Id;
  /** episodeNumber 是展示用集序。 */
  episodeNumber: number;
  /** progressSeconds 是已确认的本机播放位置。 */
  progressSeconds: number;
  /** durationSeconds 是该集总时长。 */
  durationSeconds: number;
  /** posterUrl 是该集真实播放时确认的过渡图；旧记录可缺省。 */
  posterUrl?: string;
  /** updatedAt 是最后更新本机位置的时间。 */
  updatedAt: string;
}

interface LocalLibrarySnapshot {
  follows: LocalFollowRecord[];
  history: LocalHistoryRecord[];
}

/** LocalLibraryStore 只在当前设备本地保存收藏、历史和进度，不调用任何服务端 API。 */
export class LocalLibraryStore {
  private readonly storageKey: string;
  private storageUnavailable = false;
  private fallback?: LocalLibrarySnapshot;

  constructor(
    /** applicationCode 隔离不同小程序的本地阅读数据。 */
    applicationCode: string,
    /** visitorId 使用服务端已确认的主体；不存 OpenID、SDK 元数据或权益凭据。 */
    visitorId: string,
    private readonly storage: StorageLike = browserStorage(),
    private readonly now: () => Date = () => new Date(),
  ) {
    const normalizedApplicationCode = normalizeId(applicationCode);
    if (!normalizedApplicationCode) throw new Error("applicationCode is required");
    const normalizedVisitorId = normalizeId(visitorId);
    if (!normalizedVisitorId) throw new Error("visitorId is required");
    this.storageKey = `${STORAGE_KEY_PREFIX}${JSON.stringify([normalizedApplicationCode, normalizedVisitorId])}`;
  }

  /** follows 返回当前主体收藏的隔离副本。 */
  follows(): LocalFollowRecord[] {
    return this.read().follows;
  }

  /** history 返回逐集历史副本，不合并不同分集进度。 */
  history(): LocalHistoryRecord[] {
    return this.read().history;
  }

  /** followedDramas 仅展示最新目录仍允许显示的收藏。 */
  followedDramas(dramas: readonly DramaSummary[]): FollowedDrama[] {
    const dramaByID = new Map(dramas.map((drama) => [drama.id, drama]));
    return this.follows().flatMap((item) => {
      const drama = dramaByID.get(item.dramaId);
      return drama ? [{ drama, createdAt: item.createdAt }] : [];
    });
  }

  /** continueWatching 按剧聚合最近观看记录；传入目录时仅展示命中项，省略时使用本机摘要，结果不代表播放权益。 */
  continueWatching(dramas?: readonly DramaSummary[]): ContinueWatchingItem[] {
    const records = this.history().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const dramaByID = new Map((dramas ?? [...records].reverse().flatMap(item => item.drama ? [item.drama] : [])).map((drama) => [drama.id, drama]));
    const seen = new Set<Id>();
    // 旧快照仍可能包含同剧多集；时间相同时保留原记录顺序，不能以最大集号替代最近观看。
    return records.flatMap((item) => {
      const drama = dramaByID.get(item.dramaId);
      if (!drama || seen.has(item.dramaId)) return [];
      seen.add(item.dramaId);
      return [{
        drama,
        episodeId: item.episodeId,
        episodeNumber: item.episodeNumber,
        progressSeconds: item.progressSeconds,
        durationSeconds: item.durationSeconds,
      }];
    });
  }

  /** isFollowing 查询当前主体是否收藏给定剧目。 */
  isFollowing(dramaId: Id): boolean {
    const normalizedDramaID = normalizeId(dramaId);
    return normalizedDramaID !== "" && this.follows().some((item) => item.dramaId === normalizedDramaID);
  }

  /** setFollow 幂等更新本机收藏，不发起服务端请求。 */
  setFollow(dramaId: Id, following: boolean): void {
    const normalizedDramaID = normalizeId(dramaId);
    if (!normalizedDramaID) return;
    const snapshot = this.read();
    const existing = snapshot.follows.filter((item) => item.dramaId !== normalizedDramaID);
    snapshot.follows = following
      ? [{ dramaId: normalizedDramaID, createdAt: this.now().toISOString() }, ...existing]
      : existing;
    this.write(snapshot);
  }

  /** updateHistorySummary 在重新进入短剧取得详情后更新已有历史摘要，不新增记录或改变进度与观看顺序。 */
  updateHistorySummary(input: DramaSummary): void {
    const drama = parseDramaSummary(input);
    if (!drama) return;
    const snapshot = this.read();
    const records = snapshot.history.filter(item => item.dramaId === drama.id);
    if (records.length === 0) return;
    for (const item of records) item.drama = drama;
    this.write(snapshot);
  }

  /** recordProgress 每部剧只保留最近播放的一条记录；附带摘要缺省时沿用本机已有摘要。 */
  recordProgress(input: Omit<LocalHistoryRecord, "updatedAt">): void {
    const record = parseHistoryRecord({ ...input, updatedAt: this.now().toISOString() });
    if (!record) return;
    const snapshot = this.read();
    const savedDrama = snapshot.history.find(item => item.dramaId === record.dramaId && item.drama)?.drama;
    if (!record.drama && savedDrama) record.drama = savedDrama;
    snapshot.history = [
      record,
      ...snapshot.history.filter((item) => item.dramaId !== record.dramaId),
    ].slice(0, MAX_HISTORY_ITEMS);
    this.write(snapshot);
  }

  /** mergeFrom 把旧的观众分区迁入应用本地分区；重复执行不会制造重复记录。 */
  mergeFrom(source: LocalLibraryStore): void {
    if (source === this) return;
    const current = this.read();
    const incoming = source.read();
    const follows = new Map(current.follows.map(item => [item.dramaId, item]));
    for (const item of incoming.follows) {
      const existing = follows.get(item.dramaId);
      if (!existing || Date.parse(item.createdAt) > Date.parse(existing.createdAt)) follows.set(item.dramaId, item);
    }
    const history = new Map(current.history.map(item => [`${item.dramaId}\u0000${item.episodeId}`, item]));
    for (const item of incoming.history) {
      const key = `${item.dramaId}\u0000${item.episodeId}`;
      const existing = history.get(key);
      if (!existing || Date.parse(item.updatedAt) > Date.parse(existing.updatedAt)) history.set(key, item);
    }
    this.write({
      follows: [...follows.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
      history: [...history.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_HISTORY_ITEMS),
    });
  }

  private read(): LocalLibrarySnapshot {
    if (this.storageUnavailable) return cloneSnapshot(this.fallback || emptySnapshot());
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(this.storageKey) || "{}");
      if (!isRecord(parsed)) return emptySnapshot();
      const snapshot = {
        follows: Array.isArray(parsed.follows)
          ? parsed.follows.map(parseFollowRecord).filter((item): item is LocalFollowRecord => item !== null)
          : [],
        history: Array.isArray(parsed.history)
          ? parsed.history.map(parseHistoryRecord).filter((item): item is LocalHistoryRecord => item !== null)
          : [],
      };
      this.fallback = cloneSnapshot(snapshot);
      return snapshot;
    } catch (reason) {
      this.storageUnavailable = true;
      logClientEvent("warn", "local_library_read_failed", { error: safeErrorMessage(reason) });
      return cloneSnapshot(this.fallback || emptySnapshot());
    }
  }

  private write(snapshot: LocalLibrarySnapshot): void {
    // 故障后保留最近已知视图；本页不盲目恢复写盘，避免覆盖读取失败时未知的磁盘记录。
    this.fallback = cloneSnapshot(snapshot);
    if (this.storageUnavailable) {
      this.fallback = cloneSnapshot(snapshot);
      return;
    }
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(snapshot));
    } catch (reason) {
      this.storageUnavailable = true;
      logClientEvent("warn", "local_library_write_failed", { error: safeErrorMessage(reason) });
      this.fallback = cloneSnapshot(snapshot);
    }
  }
}

function emptySnapshot(): LocalLibrarySnapshot {
  return { follows: [], history: [] };
}

function cloneSnapshot(snapshot: LocalLibrarySnapshot): LocalLibrarySnapshot {
  return {
    follows: snapshot.follows.map((item) => ({ ...item })),
    history: snapshot.history.map((item) => ({ ...item, ...(item.drama ? { drama: { ...item.drama, tags: [...item.drama.tags] } } : {}) })),
  };
}

function parseFollowRecord(value: unknown): LocalFollowRecord | null {
  if (!isRecord(value)) return null;
  const dramaId = normalizeId(value.dramaId);
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  return dramaId && Number.isFinite(Date.parse(createdAt)) ? { dramaId, createdAt } : null;
}

function parseHistoryRecord(value: unknown): LocalHistoryRecord | null {
  if (!isRecord(value)) return null;
  const dramaId = normalizeId(value.dramaId);
  const episodeId = normalizeId(value.episodeId);
  const episodeNumber = finiteNumber(value.episodeNumber);
  const progressSeconds = finiteNumber(value.progressSeconds);
  const durationSeconds = finiteNumber(value.durationSeconds);
  const posterUrl = typeof value.posterUrl === "string" ? value.posterUrl.trim() : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  if (
    !dramaId || !episodeId || episodeNumber === null || episodeNumber < 1 ||
    progressSeconds === null || progressSeconds < 0 || durationSeconds === null ||
    durationSeconds <= 0 || !Number.isFinite(Date.parse(updatedAt))
  ) {
    return null;
  }
  return {
    dramaId,
    episodeId,
    episodeNumber: Math.floor(episodeNumber),
    progressSeconds: Math.min(progressSeconds, durationSeconds),
    durationSeconds,
    updatedAt,
    ...(posterUrl ? { posterUrl } : {}),
    ...(parseDramaSummary(value.drama)?.id === dramaId ? { drama: parseDramaSummary(value.drama) } : {}),
  };
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
