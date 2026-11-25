import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { PlaybackLaunchPreview } from "../../components/PlaybackLaunchPreview";
import { VipDialog } from "../../components/VipDialog";
import { getVisibilitySnapshot, observeVisibility } from "../../platform/tiktok/lifecycle";
import { useAdExperience } from "../../runtime/useAdExperience";
import { useRuntime } from "../../runtime/RuntimeContext";
import { PlaybackGate, usePlaybackGate } from "./PlaybackGate";

/** VIPEntryGateProps 剧场首次挂载后保留子树，重查期间仅暂停。 */
interface VIPEntryGateProps {
  /** children 是受入剧策略约束的剧场播放器。 */
  children: ReactNode;
}

/** VIPEntryGate 在入剧广告已达标或未启用后执行 Mini 端的可选 VIP 入剧门禁。 */
export function VIPEntryGate({ children }: VIPEntryGateProps) {
  const runtime = useRuntime();
  const parentGate = usePlaybackGate();
  const navigate = useNavigate();
  const { dramaId = "", episodeId = "" } = useParams();
  const { monetizationPolicy, vipOffer, vipState, refreshRequired, refreshError } = useAdExperience();
  const [visible, setVisible] = useState(() => getVisibilitySnapshot().visible);
  const required = monetizationPolicy.status === "enabled" && monetizationPolicy.vip.enabled &&
    monetizationPolicy.vip.requireBeforePlayback === true;
  const delaying = !!parentGate.entryAdDelay;
  // 首次展示等待两层门禁确认；展示后正常重查只暂停操作，保持同一个弹窗与倒计时。
  const [dialogOpened, setDialogOpened] = useState(false);
  if (!dialogOpened && !delaying && required && !vipState.active && !refreshRequired && !parentGate.blocked && visible) setDialogOpened(true);
  const dialogOpen = dialogOpened && !delaying && required && !vipState.active;

  useEffect(() => {
    setVisible(getVisibilitySnapshot().visible);
    if (required) return observeVisibility(window.TTMinis, setVisible);
  }, [required]);

  // 旧策略缺少开关时继续使用原有自愿领取流程；只采用当前主体的服务端 VIP 状态。
  const allowed = delaying || !required || (vipState.active && !refreshRequired);
  // 广告回前台的权益重查是正常等待，实际查询失败后才展示错误与恢复操作。
  const refreshFailure = refreshRequired ? refreshError : undefined;

  return <PlaybackGate allowed={allowed} fallback={<>
    <PlaybackLaunchPreview runtime={runtime} dramaId={dramaId} episodeId={episodeId} identityReady
      error={dialogOpen ? undefined : refreshFailure}
      onRetry={!dialogOpen && refreshFailure ? () => { void runtime.refreshAdExperience().catch(() => { /* runtime 已记录失败并更新恢复入口。 */ }); } : undefined}
      onBack={!dialogOpen && refreshFailure ? () => navigate("/", { replace: true }) : undefined} />
    <VipDialog open={dialogOpen} mandatory offer={vipOffer} visible={visible && !parentGate.blocked}
      onClose={() => navigate("/", { replace: true })} />
  </>}>{children}</PlaybackGate>;
}
