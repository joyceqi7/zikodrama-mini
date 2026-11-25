import type { PlaybackSnapshot } from "./playbackEngine";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

export interface LocalPlaybackProgress {
  /** dramaId 为业务短剧标识，不保存官方播放凭据。 */
  dramaId: string;
  /** episodeId 为当前已确认播放的业务剧集标识。 */
  episodeId: string;
  /** currentTime 为播放器当前位置，单位秒。 */
  currentTime: number;
  /** duration 为播放器报告的总时长，单位秒。 */
  duration: number;
}

type SaveProgress = (input: LocalPlaybackProgress) => void;

/** PlaybackProgressReporter 在空闲时保存周期进度，生命周期边界仍同步补写。 */
export class PlaybackProgressReporter {
  private dramaId = "";
  private episodeId = "";
  /** lastSavedSecond 是最近一次成功本地写入的整秒位置，用于正向播放和回拖节流。 */
  private lastSavedSecond = 0;
  private latest?: PlaybackSnapshot;
  private idleSave?: number;
  private timerSave?: ReturnType<typeof setTimeout>;

  constructor(private readonly save: SaveProgress) {}

  /** setTarget 在新一集开始接收进度前重置节流阈值。 */
  setTarget(
    dramaId: string,
    episodeId: string,
  ): void {
    this.cancelScheduledSave();
    this.dramaId = dramaId;
    this.episodeId = episodeId;
    this.lastSavedSecond = 0;
    this.latest = undefined;
  }

  /** clearTarget 在切源与卸载时停止接收迟到的播放事件。 */
  clearTarget(): void {
    this.cancelScheduledSave();
    this.dramaId = "";
    this.episodeId = "";
    this.latest = undefined;
  }

  /** report 只记录最新位置；跨过五秒阈值后在空闲时写入，避免阻塞播放器时间回调。 */
  report(snapshot: PlaybackSnapshot): void {
    if (!this.dramaId || !this.episodeId) return;
    this.latest = snapshot;
    const wholeSecond = Math.floor(snapshot.currentTime);
    if (
      !this.dramaId ||
      !this.episodeId ||
      wholeSecond < 0 ||
      Math.abs(wholeSecond - this.lastSavedSecond) < 5
    )
      return;
    this.scheduleSave();
  }

  /** flush 在暂停、切集和退出前立即落到本地，不依赖页面退出后继续执行异步任务。 */
  flush(snapshot: PlaybackSnapshot | undefined = this.latest): void {
    this.cancelScheduledSave();
    // ENDED 的最终快照也成为最新值，防止随后卸载时再写回较早的 TIME_UPDATE。
    if (snapshot) this.latest = snapshot;
    if (
      snapshot &&
      this.dramaId &&
      this.episodeId &&
      snapshot.currentTime >= 0 &&
      Math.floor(snapshot.currentTime) !== this.lastSavedSecond
    ) {
      this.saveSnapshot(snapshot);
    }
  }

  /** scheduleSave 给视频合成与手势让路；宿主没有空闲回调时短暂延后到独立任务。 */
  private scheduleSave(): void {
    if (this.idleSave !== undefined || this.timerSave !== undefined) return;
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      this.idleSave = window.requestIdleCallback(() => {
        this.idleSave = undefined;
        this.saveLatest();
      }, { timeout: 2_000 });
      return;
    }
    this.timerSave = setTimeout(() => {
      this.timerSave = undefined;
      this.saveLatest();
    }, 200);
  }

  /** cancelScheduledSave 避免切集后旧集的延迟任务使用新集上下文。 */
  private cancelScheduledSave(): void {
    if (this.idleSave !== undefined) window.cancelIdleCallback(this.idleSave);
    if (this.timerSave !== undefined) clearTimeout(this.timerSave);
    this.idleSave = undefined;
    this.timerSave = undefined;
  }

  /** saveLatest 只保存当前目标的最新快照，合并等待期间到达的时间更新。 */
  private saveLatest(): void {
    const snapshot = this.latest;
    if (snapshot && this.dramaId && this.episodeId && snapshot.currentTime >= 0 &&
      Math.abs(Math.floor(snapshot.currentTime) - this.lastSavedSecond) >= 5) this.saveSnapshot(snapshot);
  }

  /** saveSnapshot 把当前剧集与位置一起同步交给本地存储；失败时保留重试机会。 */
  private saveSnapshot(snapshot: PlaybackSnapshot): void {
    const input: LocalPlaybackProgress = {
      dramaId: this.dramaId,
      episodeId: this.episodeId,
      currentTime: snapshot.currentTime,
      duration: snapshot.duration,
    };
    try {
      this.save(input);
      this.lastSavedSecond = Math.floor(snapshot.currentTime);
    } catch (reason) {
      // 本地历史不是权益结算；存储异常不阻断官方播放，下一次事件仍可再次尝试。
      logClientEvent("warn", "local_playback_progress_save_failed", { error: safeErrorMessage(reason) });
    }
  }
}
