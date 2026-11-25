/** PostbackScene 只记录固定业务入口，不采集页面 URL 或启动参数。 */
export type PostbackScene = "playback" | "entry_reward" | "episode_unlock" | "vip_reward" | "home_interstitial" | "pause_interstitial";

/** PostbackDetails 是交给官方 SDK 的参数白名单快照；OpenID 在采集前替换为固定占位符。 */
export interface PostbackDetails {
  /** scene 区分播放、入剧、VIP 和插屏入口。 */
  scene: PostbackScene;
  /** clientVersion 是构建修订，不能用 TikTok 客户端版本代替 Mini 版本。 */
  clientVersion: string;
  /** params 保留省略、null 和空字符串的差别，绝不携带真实 OpenID。 */
  params: Record<string, string | number | null>;
  /** warnings 是参数上下文不足的固定分类，不等同于官方拒收结论。 */
  warnings: string[];
  /** elapsedMs 是调用至结果的单调时钟耗时，未调用时不提供。 */
  elapsedMs?: number;
  /** reason 区分拒绝、异常、能力缺失、身份变化和回调超时。 */
  reason?: string;
  /** errorCode 只接受数值错误码，不能把 SDK 原始对象写入统计。 */
  errorCode?: string;
  /** subErrorCode 保留官方可选子错误码。 */
  subErrorCode?: string;
  /** errorMessage 是已去除凭据和 URL 的诊断消息。 */
  errorMessage?: string;
}

/** miniBuildVersion 由构建时注入 Git 修订，测试或旧打包器缺失时使用明确未知值。 */
export function miniBuildVersion(): string {
  return typeof __MINI_BUILD_ID__ === "string" ? __MINI_BUILD_ID__ : "unknown";
}
