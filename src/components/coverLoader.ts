import { logClientEvent } from "../observability/clientLog";
import { coverThumbnail } from "./coverThumbnail";

/** CoverPriority 控制排队顺序和并发名额；低优先级图片仍会持续请求。 */
export type CoverPriority = "high" | "auto" | "low";
/** CoverState 区分等待、下载、解码完成及终止失败，供所有卡片共享。 */
export interface CoverState {
  /** status 为轮播提供解码完成信号，不能以请求开始代替就绪。 */
  status: "queued" | "loading" | "ready" | "error";
  /** src 保留完整资源版本与签名，只在任务获准后赋值。 */
  src?: string;
}
/** CoverResource 为同一资源的多个组件共享状态和通知。 */
export interface CoverResource {
  /** snapshot 返回稳定对象以支持 React 外部订阅。 */
  snapshot(): CoverState;
  /** settle 接收实际展示节点的加载结果，与预请求共享一次完成通知。 */
  settle(success: boolean): void;
  /** subscribe 订阅源变化，返回解绑方法。 */
  subscribe(listener: () => void): () => void;
}
type Task = CoverResource & {
  source: string; original: string; priority: number; state: CoverState;
  listeners: Set<() => void>; image?: HTMLImageElement; timer?: ReturnType<typeof setTimeout>;
  startedAt: number; finishedAt: number; order: number; queuedAt: number; finish?: (success: boolean) => void; cancel?: () => void;
  runningLow?: boolean; runningNonHigh?: boolean;
};
const priorities = { high: 0, auto: 1, low: 2 };

/** CoverLoader 按资源去重并限制下载并发；超时和坏图不会阻塞后续图片。 */
export class CoverLoader {
  private tasks = new Map<string, Task>();
  private active = 0;
  private activeLow = 0;
  private activeNonHigh = 0;
  private sequence = 0;
  /** constructor 配置下载名额，避免首页图片同时抢占连接。 */
  constructor(private readonly concurrency = 4) {}
  /** request 登记完整资源地址；缩略图只改写明确支持的未签名 VOD 模板。 */
  request(source: string, priority: CoverPriority = "auto", thumbnail = false): CoverResource {
    const original = source.trim();
    const url = thumbnail ? coverThumbnail(original, 480) : original;
    const key = JSON.stringify([url, original]);
    let task = this.tasks.get(key);
    if (!task) {
      const listeners = new Set<() => void>();
      task = {
        source: url, original, priority: priorities[priority], state: { status: "queued" }, listeners,
        startedAt: 0, finishedAt: 0, order: ++this.sequence, queuedAt: Date.now(),
        settle: success => task!.finish?.(success),
        snapshot: () => task!.state,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
      this.tasks.set(key, task);
    } else {
      task.priority = Math.min(task.priority, priorities[priority]);
      if (task.image && priority === "high") task.image.fetchPriority = "high";
      // 坏图不永久缓存；重访时有限重试，新 URL 立即作为新资源加载。
      if (task.state.status === "error" && Date.now() - task.finishedAt > 30_000) task.state = { status: "queued" };
    }
    this.pump();
    return task;
  }
  private pump(): void {
    // 已等候十秒的任务按登记顺序执行，避免持续交互饿死屏外图片。
    while (this.active < this.concurrency) {
      // 屏外封面最多占一半名额，所有非首屏任务合计留出一个名额；
      // 轮播接口晚于目录或热播返回时，主封面仍能立即开始下载。
      const lowLimit = Math.max(1, Math.floor(this.concurrency / 2));
      const nonHighLimit = this.concurrency > 1 ? this.concurrency - 1 : 1;
      const pending = [...this.tasks.values()].filter(t => t.state.status === "queued" &&
        (t.priority === priorities.high || this.activeNonHigh < nonHighLimit) &&
        (t.priority !== priorities.low || this.activeLow < lowLimit));
      const task = pending.sort((a, b) => (Date.now() - a.queuedAt > 10_000 ? -1 : a.priority) - (Date.now() - b.queuedAt > 10_000 ? -1 : b.priority) || a.order - b.order)[0];
      if (!task) break;
      this.start(task, task.source);
    }
    if (this.tasks.size > 128) {
      for (const [key, task] of this.tasks) {
        if (this.tasks.size <= 128) break;
        if (!task.listeners.size && (task.state.status === "ready" || task.state.status === "error")) this.tasks.delete(key);
      }
    }
  }
  private publish(task: Task, state: CoverState): void {
    task.state = state;
    task.listeners.forEach(listener => listener());
  }
  private start(task: Task, src: string): void {
    ++this.active;
    task.runningLow = task.priority === priorities.low;
    task.runningNonHigh = task.priority !== priorities.high;
    if (task.runningLow) ++this.activeLow;
    if (task.runningNonHigh) ++this.activeNonHigh;
    task.startedAt = performance.now();
    const image = new Image();
    task.image = image;
    image.decoding = "async";
    image.fetchPriority = task.priority === 0 ? "high" : task.priority === 2 ? "low" : "auto";
    let done = false;
    const finish = (success: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(task.timer);
      image.onload = null; image.onerror = null;
      // 任务只负责预请求与解码信号；展示节点拥有自己的图片引用。
      // 完成后断开闭包和预请求节点，避免首页资源的解码位图在进入播放器后仍常驻。
      image.src = "";
      task.image = undefined;
      task.timer = undefined;
      task.finish = undefined;
      task.cancel = undefined;
      --this.active;
      if (task.runningLow) --this.activeLow;
      if (task.runningNonHigh) --this.activeNonHigh;
      task.runningLow = false;
      task.runningNonHigh = false;
      if (!success && src !== task.original) {
        logClientEvent("warn", "media_thumbnail_load_failed", { error: "Cover thumbnail failed; retrying original image" });
        this.start(task, task.original);
        return;
      }
      task.finishedAt = Date.now();
      this.publish(task, { status: success ? "ready" : "error", src });
      logClientEvent(success ? "info" : "warn", "cover_load_settled", {
        elapsedMs: Math.round(performance.now() - task.startedAt), outcome: success ? "success" : "failed",
        error: success ? undefined : "Cover image failed to load or decode",
      });
      this.pump();
    };
    task.cancel = () => { done = true; image.onload = null; image.onerror = null; image.src = ""; };
    task.finish = finish;
    image.onload = () => {
      if (image.decode) void image.decode().then(() => finish(true), () => finish(false));
      else finish(true);
    };
    image.onerror = () => finish(false);
    task.timer = setTimeout(() => finish(false), 15_000);
    this.publish(task, { status: "loading", src });
    image.src = src;
  }
  /** dispose 释放当前加载器的计时器与图片回调，用于会话销毁和测试隔离。 */
  dispose(): void {
    for (const task of this.tasks.values()) {
      clearTimeout(task.timer);
      task.cancel?.();
    }
    this.tasks.clear(); this.active = 0; this.activeLow = 0; this.activeNonHigh = 0;
  }
}
/** coverLoader 在当前页面内共享封面，不持久化签名地址或跨环境复用。 */
export const coverLoader = new CoverLoader();
