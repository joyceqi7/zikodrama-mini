/** adErrorPolicy 只控制尽力而为的广告错误日志，不采样或改变指标计数。 */
export const adErrorPolicy = {
  /** batchDelayMs 给相近失败留出合批窗口；成功广告不会启动计时器。 */
  batchDelayMs: 2_000,
  /** minIntervalMs 限制当前页面的发送频率，切换身份也不重置。 */
  minIntervalMs: 10_000,
  /** failureBackoffMs 在网络、鉴权或限流失败后暂停发送；失败批次不重试。 */
  failureBackoffMs: 60_000,
  /** batchSize 与广告错误接口的五条上限一致。 */
  batchSize: 5,
  /** queueSize 限制内存占用；队列满时丢弃新增现场，指标仍独立记录。 */
  queueSize: 20,
} as const;
