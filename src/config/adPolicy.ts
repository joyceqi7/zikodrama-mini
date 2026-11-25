/** adPolicy 定义客户端等待和退避策略，不代表 TikTok 的广告时长或平台频控阈值。 */
export const adPolicy = {
  /** rewardedShowTimeoutMs 仅限制前台等待展示的时间，超时不推断原生广告已终止。 */
  rewardedShowTimeoutMs: 15_000,
  /** rewardedCloseTimeoutMs 限制前台等待关闭回调的时间，不能代替完播证明。 */
  rewardedCloseTimeoutMs: 300_000,
  /** interstitialTimeoutMs 限制插屏每个阶段的前台等待时间。 */
  interstitialTimeoutMs: 120_000,
  /** retryDelayMs 对 50008 以外的明确失败阻止同容器跨广告位、跨类型立即重试，不限制正常关闭后的业务续看。 */
  retryDelayMs: 5_000,
  /** rewardedSilentRetries 每次业务观看最多静默重试一次，仅用于明确未展示的宿主容器失败或活动冲突。 */
  rewardedSilentRetries: 1,
  /** rewardedRecoveryDelayMs 给宿主容器及上一广告活动留出退场时间，不代表宿主已确认恢复。 */
  rewardedRecoveryDelayMs: 5_000,
  /** nativeAdRecoveryCheckMs 在广告恢复期间检查本地原生活动与业务意图，不发送请求。 */
  nativeAdRecoveryCheckMs: 250,
  /** interstitialStartupDelayMs 为本次 WebView 会话保留启动宽限。 */
  interstitialStartupDelayMs: 60_000,
  /** interstitialIntervalMs 为插屏保留现有的业务展示间隔。 */
  interstitialIntervalMs: 180_000,
} as const;
