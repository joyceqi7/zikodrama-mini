/** TimeGeneration 只存在当前 API 实例内；换号及前后台切换使旧截止点失效。 */
interface TimeGeneration {
  /** value 递增后，旧响应不能继续用于有效期判断。 */
  value: number;
}

/** ServerDeadline 由单次服务器响应换算，只用于刷新和缓存，不作为权益证明或持久化数据。 */
export interface ServerDeadline {
  /** at 是页面单调时钟上的截止点，已保守扣除本次请求往返耗时。 */
  at: number;
  /** generation 是创建该截止点时的页面与主体代次。 */
  generation: number;
  /** context 是当前 API 实例的代次引用，不在账号或页面之间共享。 */
  context: TimeGeneration;
}

/** TimedValue 声明本地响应附带的时间元数据，不增加服务端业务字段或请求参数。 */
export interface TimedValue {
  /** serverDeadline 只从有效 serverTime 和响应绝对期限生成；缺失时有效期未确认。 */
  serverDeadline?: ServerDeadline;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** parseServerTimestamp 校验响应中的 RFC 3339 时刻，不采用设备当地日期解释缺少时区的值。 */
export function parseServerTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !timestampPattern.test(value)) return;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(value.slice(11, 13)) > 23 ||
      Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** remainingServerTime 返回当前页面的剩余毫秒；无基准为 undefined，旧代次或过期为 0。 */
export function remainingServerTime(value: object): number | undefined {
  const deadline = (value as TimedValue).serverDeadline;
  if (!deadline) return;
  if (deadline.generation !== deadline.context.value) return 0;
  return Math.max(0, deadline.at - performance.now());
}

/** ServerClock 为每次响应建立独立截止点，不保存设备 Date.now() 偏移或跨页面的校时值。 */
export class ServerClock {
  private readonly context: TimeGeneration = { value: 0 };
  private readonly baselines = new WeakMap<object, { serverTime: unknown; startedAt: number; generation: number; order: number }>();
  private latest?: { serverAt: number; receivedAt: number; generation: number; order: number };

  /** generation 供请求入口固定发起代次，后台期间返回的旧响应仍保持失效。 */
  get generation(): number { return this.context.value; }

  /** invalidate 在主体切换或后台边界清理旧时间基准；旧对象中的截止点随即失效。 */
  invalidate(): void { this.context.value += 1; this.latest = undefined; }

  /** now 返回本页当前前台代次的服务器时间估计，仅供补报保留期；基准缺失时不使用手机时间替代。 */
  now(): number | undefined {
    const latest = this.latest;
    if (!latest || latest.generation !== this.generation) return;
    return latest.serverAt + Math.max(0, performance.now() - latest.receivedAt);
  }

  /** bind 给当前响应的有效期附上单调截止点；数组、领奖内播放许可和 VIP 状态采用同一响应基准。 */
  bind<T>(value: T, serverTime: unknown, startedAt: number, generation: number, order: number): T {
    if (!value || typeof value !== "object") return value;
    this.baselines.set(value, { serverTime, startedAt, generation, order });
    const serverAt = parseServerTimestamp(serverTime);
    if (serverAt !== undefined && generation === this.generation && order >= (this.latest?.order ?? 0)) {
      this.latest = { serverAt, receivedAt: performance.now(), generation, order };
    }
    const visit = (item: unknown) => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) { item.forEach(visit); return; }
      const record = item as Record<string, unknown>;
      if ((typeof record.active === "boolean" && typeof record.adCount === "number") || (typeof record.enabled === "boolean" && typeof record.completedCount === "number")) Object.defineProperty(record, "responseOrder", { value: order, configurable: true });
      delete record.serverDeadline;
      const absolute = parseServerTimestamp(record.expiresAt ?? record.validUntil);
      if (serverAt !== undefined && absolute !== undefined) {
        record.serverDeadline = { at: startedAt + Math.max(0, absolute - serverAt), generation, context: this.context } satisfies ServerDeadline;
      }
      for (const [key, nested] of Object.entries(record)) if (key !== "serverDeadline") visit(nested);
    };
    visit(value);
    return value;
  }

  /** changeIdentity 使旧账号时间失效，并只为当前成功启动响应重新绑定原始时间基准。 */
  changeIdentity<T extends object>(value: T): void {
    const baseline = this.baselines.get(value);
    const wasCurrent = baseline?.generation === this.generation;
    this.invalidate();
    if (baseline) this.bind(value, baseline.serverTime, baseline.startedAt, wasCurrent ? this.generation : baseline.generation, baseline.order);
  }
}
