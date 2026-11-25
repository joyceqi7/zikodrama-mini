import { getVisibilitySnapshot } from "./lifecycle";

/** AdIntent 固定展示请求所属的页面可见周期；业务通过 isCurrent 校验路由、主体和 Offer。 */
export interface AdIntent {
  /** visibilityEpoch 是意图产生时的可见性版本，后台往返后不得继续旧请求。 */
  visibilityEpoch: number;
  /** userInitiated 只由实际手动重试设置，倒计时及自动衔接不得借此解除 50008 暂停。 */
  userInitiated: boolean;
  /** isCurrent 在 create 与 show 前确认业务目标仍有效，不改变奖励归属。 */
  isCurrent(): boolean;
}

/** captureAdIntent 应在可能等待的查询或门禁前调用；恢复前台后须按最新业务条件重新生成。 */
export function captureAdIntent(isCurrent: () => boolean = () => true, userInitiated = false): AdIntent {
  return { visibilityEpoch: getVisibilitySnapshot().epoch, userInitiated, isCurrent };
}
