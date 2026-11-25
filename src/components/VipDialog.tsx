import { captureAdIntent, type AdIntent } from "../platform/tiktok/adIntent";
import { getVisibilitySnapshot, observeVisibility } from "../platform/tiktok/lifecycle";
import { Check, Crown, Play, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { text as t } from "../copy";

import { userMessage } from "../api/userMessage";
import { ApiError } from "../api/httpMiniDramaApi";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import type { AccessOffer, VIPState } from "../domain/types";
import { useRuntime } from "../runtime/RuntimeContext";
import { useAdExperience } from "../runtime/useAdExperience";
import { adPolicy } from "../config/adPolicy";

interface VipDialogProps {
  /** open 控制本次 VIP 入口的展示周期。 */
  open: boolean;
  /** mandatory 入剧门禁自动开始广告；普通首页入口保持手动开始。 */
  mandatory?: boolean;
  /** offer 使用服务端下发的独立规则进度和广告入口。 */
  offer?: AccessOffer;
  /** visible 合并 Web 页面与 TikTok Minis 宿主生命周期，原生广告期间冻结业务弹层。 */
  visible?: boolean;
  /** onClose 关闭首页弹窗或退出入剧门禁，不改变权益或广告进度。 */
  onClose(): void;
  /** onVIPActivated 在服务端确认 VIP 有效后通知父页面刷新当前播放许可。 */
  onVIPActivated?(): void;
}

interface VIPAdCountdownProps {
  /** seconds 是本轮自动拉起前的前台等待秒数。 */
  seconds: number;
  /** visible 为 false 时保留剩余秒数并停止调度。 */
  visible: boolean;
  /** onStart 到零传 false，提前点击传 true，两者共用原生广告等待逻辑。 */
  onStart(userInitiated: boolean): void;
}

/** VIPAdCountdown 每轮独立计时，后台暂停，关闭弹窗后取消待拉起广告。 */
function VIPAdCountdown({ seconds, visible, onStart }: VIPAdCountdownProps) {
  const [remaining, setRemaining] = useState(seconds);
  const statusId = useId();
  useEffect(() => {
    if (!visible) return;
    if (remaining <= 0) { onStart(false); return; }
    const timer = window.setTimeout(() => setRemaining(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, visible, onStart]);
  return <>
    <p id={statusId} role="status">{t("vip.adCountdown", { seconds: remaining })}</p>
    <button className="primary-command" type="button" aria-describedby={statusId} onClick={() => onStart(true)} disabled={!visible}>
      <Play size={18} fill="currentColor" aria-hidden="true" />{t("vip.watchAd")}
    </button>
  </>;
}

/** VipDialog 首页自愿领取在取消后停止；强弹门禁自动接续直到服务端确认达标或发生故障。 */
export function VipDialog({
  open,
  mandatory = false,
  offer,
  visible = true,
  onClose,
  onVIPActivated,
}: VipDialogProps) {
  const runtime = useRuntime();
  const sessionSubject = runtime.getSessionSubjectKey?.();
  const { monetizationPolicy, vipState: globalVIPState, refreshRequired, refreshError } = useAdExperience();
  // 各规则进度独立；当前领取响应优先于弹窗打开时的快照。
  const [settled, setSettled] = useState<{ offerId?: string; state: VIPState }>();
  const progressState = settled?.offerId === offer?.offerId && settled?.state.progressDate === globalVIPState.progressDate ? settled?.state : undefined;
  const offerState = offer?.vipState?.progressDate === globalVIPState.progressDate ? offer.vipState : undefined;
  // 旧 offer 或领取结果不得把已到期/被撤销的全局权益重新显示为有效。
  const vipState = { ...(progressState ?? offerState ?? globalVIPState), active: globalVIPState.active };
  const [busy, setBusy] = useState(false);
  // 倒计时与手动点击可能同轮触发，使用同步锁避免重复创建广告。
  const busyRef = useRef(false);
  const current = useRef({ open, visible, offer, runtime, sessionSubject });
  const generation = useRef(0);
  if (current.current.open !== open || current.current.offer !== offer || current.current.runtime !== runtime || current.current.sessionSubject !== sessionSubject) generation.current += 1;
  current.current = { open, visible, offer, runtime, sessionSubject };
  const alive = useRef(true);
  const foregroundRetry = useRef(false);
  // 最多保留本轮的一次点击；等待期间不请求 Offer、不调用 SDK，也不把后续自动接续标记为手动。
  const manualIntent = useRef<AdIntent | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => observeVisibility(window.TTMinis, next => {
    if (!next && manualIntent.current) {
      manualIntent.current = undefined;
      // 后台往返作废旧点击；强弹回前台重新自动判断，自愿入口必须重新点击。
      foregroundRetry.current = mandatory;
      setAutoContinue(false);
    }
    if (next && foregroundRetry.current && current.current.open) {
      foregroundRetry.current = false;
      setError("");
      setAutoContinue(mandatory);
    }
  }), [mandatory]);
  const [autoContinue, setAutoContinue] = useState(false);
  // 取消不改变服务端次数；独立轮次保证零秒配置也能接续并重置下一轮倒计时。
  const [adAttempt, setAdAttempt] = useState(0);
  const [error, setError] = useState("");
  // 正常确认只显示等待文案；真实刷新或业务故障才提供重试入口。
  const refreshFailure = refreshError || error;
  const dialogRef = useRef<HTMLElement>(null);
  const refreshStatusId = useId();
  const vipPolicy = offer?.vip ?? monetizationPolicy.vip;
  const available =
    offer?.kind === "rewarded_vip" ||
    (monetizationPolicy.status === "enabled" &&
      vipPolicy.enabled);

  const requiredCount = Math.max(
    1,
    vipState.requiredCount || vipPolicy.requiredAdCount,
  );
  const completedCount = Math.min(vipState.adCount, requiredCount);
  const adStartCount = useRef(completedCount);
  const progress = Math.round((completedCount / requiredCount) * 100);
  const readyToClaim = !refreshRequired && !vipState.active && completedCount >= requiredCount;
  const countdownSeconds = mandatory ? vipPolicy.entryAdCountdownSeconds ?? 0 : 0;
  const watch = useCallback(async (userInitiated = false) => {
    if (!open || busyRef.current || busy || refreshRequired || vipState.active || completedCount >= requiredCount || !visible || !available) return;
    const ticket = generation.current;
    const currentTarget = () => alive.current && ticket === generation.current && current.current.open && current.current.offer === offer && sessionSubject === runtime.getSessionSubjectKey?.();
    if (userInitiated) {
      if (manualIntent.current) return;
      manualIntent.current = captureAdIntent(() => currentTarget() && current.current.visible, true);
    }
    const intent = manualIntent.current ?? captureAdIntent(() => currentTarget() && current.current.visible);
    if (manualIntent.current && (!intent.isCurrent() || !getVisibilitySnapshot().visible || intent.visibilityEpoch !== getVisibilitySnapshot().epoch)) {
      manualIntent.current = undefined;
      setAutoContinue(mandatory);
      setAdAttempt(value => value + 1);
      return;
    }
    // 手动与自动都等待旧 onClose；点击只保留单次意图，不生成必被原生互斥拒绝的新业务调用。
    if (runtime.isFullscreenAdActive?.()) {
      if (userInitiated) {
        setError("");
        foregroundRetry.current = false;
        setAutoContinue(true);
      }
      // 调度检查通过后也可能再次被占用，交回同一等待流程，保留尚未消费的点击。
      setAdAttempt(value => value + 1);
      return;
    }
    manualIntent.current = undefined;
    busyRef.current = true;
    setBusy(true);
    setError("");
    foregroundRetry.current = false;
    adStartCount.current = completedCount;
    const foreground = getVisibilitySnapshot().foregroundEpoch;
    try {
      const claim = await runtime.watchVIPAd(offer, intent);
      if (!currentTarget()) return;
      if (!claim) {
        // 强弹 VIP 取消后重新按配置倒计时，未完播不计进度；首页自愿领取仍等待点击。
        if (runtime.getAdExperience().vipState.active) {
          onVIPActivated?.();
          return;
        }
        setAutoContinue(mandatory);
        if (!mandatory) setError(t("gate.earlyClosed"));
        return;
      }
      const nextState = claim?.vipState;
      if (nextState) setSettled({ offerId: offer?.offerId, state: nextState });
      if (nextState?.active) {
        setAutoContinue(false);
        onVIPActivated?.();
      } else if (nextState && nextState.adCount >= nextState.requiredCount) {
        // 达标后等待权益状态确认或用户领取，不再请求多余的广告。
        setAutoContinue(false);
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "vip_refresh_pending") {
        // 入剧广告的回前台信号可能迟于 VIP 入口查询；保留自动衔接，等权威状态确认后再调度。
        logClientEvent("info", "vip_rewarded_ad_deferred", { error: safeErrorMessage(reason) });
        return;
      }
      logClientEvent(reason instanceof ApiError && (reason.code === "rewarded_ad_pending" || reason.code === "ad_foreground_required") ? "warn" : "error",
        "vip_rewarded_ad_failed", { error: safeErrorMessage(reason) });
      if (!currentTarget()) return;
      const recoverable = reason instanceof ApiError && reason.code === "ad_foreground_required";
      const visibility = getVisibilitySnapshot();
      // Offer 等待期间可能已经完成前台往返；只接续旧周期的可恢复失败，当前周期的 50008 仍等待新前台或手动操作。
      const resumed = recoverable && visibility.visible && visibility.foregroundEpoch > foreground;
      foregroundRetry.current = recoverable && !resumed;
      setAutoContinue(resumed && mandatory);
      setError(resumed ? "" : userMessage(reason, t("vip.grantError")));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setAdAttempt(value => value + 1);
    }
  }, [available, busy, completedCount, mandatory, offer, onVIPActivated, open, refreshRequired, requiredCount, runtime, sessionSubject, vipState.active, visible]);
  const startAd = useCallback((userInitiated: boolean) => void watch(userInitiated), [watch]);

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    // 迟到完播经服务端确认后撤去等待提示，仍由用户决定是否继续下一条广告。
    if (error === t("runtime.rewardedAdPending") && completedCount > adStartCount.current) setError("");
  }, [completedCount, error]);

  const claimVIP = async () => {
    if (busyRef.current || busy || !readyToClaim) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await runtime.claimVIP();
      setSettled({ offerId: offer?.offerId, state });
      onVIPActivated?.();
    } catch (reason) {
      // Runtime 已记录领取失败；弹窗只负责给用户展示统一提示。
      setError(userMessage(reason, t("vip.grantError")));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) { setSettled(undefined); setAutoContinue(false); setError(""); }
    else if (mandatory) setAutoContinue(true);
  }, [open, mandatory]);
  useEffect(() => {
    // 原生广告返回后重新接管焦点，关闭和重试入口仍可用。
    if (open && !busy) dialogRef.current?.focus({ preventScroll: true });
  }, [open, busy, error, refreshRequired]);

  useEffect(() => {
    const pending = manualIntent.current;
    // 等待期间目标、可见周期或广告资格变化即撤销点击，不能在资格后来恢复时补播旧意图。
    if (pending && (!pending.isCurrent() || pending.visibilityEpoch !== getVisibilitySnapshot().epoch || !visible || !available || vipState.active || completedCount >= requiredCount)) {
      manualIntent.current = undefined;
      setAutoContinue(mandatory && open);
      setAdAttempt(value => value + 1);
      return;
    }
    if (!open || !visible || !available || !autoContinue || busy || refreshRequired || vipState.active || completedCount >= requiredCount || error) return;
    if (runtime.isFullscreenAdActive?.()) {
      // 只观察本地状态，保留恢复决定；关闭、卸载、后台或权益变化时由 effect 清理等待。
      const timer = window.setTimeout(() => setAdAttempt(value => value + 1), adPolicy.nativeAdRecoveryCheckMs);
      return () => window.clearTimeout(timer);
    }
    if (!manualIntent.current && mandatory && countdownSeconds > 0) return;
    // 每次完整结算后，由最新服务端进度决定是否接续下一条；弹窗关闭时取消调度。
    const timer = window.setTimeout(() => void watch(), 0);
    return () => window.clearTimeout(timer);
  }, [adAttempt, autoContinue, available, busy, completedCount, countdownSeconds, error, mandatory, open, refreshRequired, requiredCount, runtime, vipState.active, visible, watch]);

  if (!open || !available) return null;

  return (
    <div className="vip-dialog-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="vip-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={!!refreshRequired || busy}
        aria-labelledby="vip-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
          if (!controls.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
          }
        }}
      >
        <header>
          <span className="vip-dialog-mark"><Crown aria-hidden="true" /></span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("vip.closeOffer")} title={t("common.close")}>
            <X />
          </button>
        </header>

        {/* 未激活 VIP 的正常重查保留进度布局，暂停倒计时与操作，避免弹窗缩成等待页后再次展开。 */}
        {refreshRequired && (vipState.active || refreshFailure) ? (
          <div className="vip-dialog-copy">
            <h2 id="vip-dialog-title">{t("vip.dailyPass")}</h2>
            <p id={refreshStatusId} role={refreshFailure ? "alert" : "status"}>{refreshFailure || t("vip.checkingAccess")}</p>
            {refreshFailure && <button type="button" className="primary-command" aria-describedby={refreshStatusId} disabled={busy || !visible}
              onClick={() => {
                if (busyRef.current) return;
                // 强制门禁重试成功后接续原自动流程；自愿领取仍由用户决定下一条广告。
                busyRef.current = true; setBusy(true); setError(""); setAutoContinue(mandatory);
                void runtime.refreshAdExperience().then(() => {
                  const latest = runtime.getAdExperience();
                  if (latest.vipState.active && !latest.refreshRequired) onVIPActivated?.();
                }).catch(reason => {
                  // 运行时负责实际故障日志；这里保留统一文案和可重复操作的入口。
                  setError(userMessage(reason, t("apiErrors.responseUnconfirmed")));
                }).finally(() => { busyRef.current = false; setBusy(false); });
              }}>{t("common.retry")}</button>}
          </div>
        ) : vipState.active ? (
          <div className="vip-dialog-copy vip-active-copy">
            <span className="vip-status-line"><Check aria-hidden="true" />{t("vip.passUnlocked")}</span>
            <h2 id="vip-dialog-title">{t("vip.activeToday")}</h2>
            <p>{t("vip.activeDetail")}</p>
            <button type="button" className="primary-command" onClick={onClose}>{t("vip.startWatching")}</button>
          </div>
        ) : (
          <div className="vip-dialog-copy">
            <span className="vip-status-line">{t("vip.dailyPass")}</span>
            <h2 id="vip-dialog-title">{vipPolicy.title || t("vip.defaultTitle")}</h2>
            <p>{vipPolicy.content || t("vip.defaultContent")}</p>
            <div className="vip-progress" aria-label={t("vip.sponsoredProgress", { completed: completedCount, required: requiredCount })}>
              <span>{t("vip.sponsoredProgress", { completed: completedCount, required: requiredCount })}</span>
              <span className="vip-progress-track"><i style={{ width: `${progress}%` }} /></span>
            </div>
            {error && <p className="vip-dialog-error" role="alert">{error}</p>}
            {readyToClaim
              ? <button type="button" className="primary-command" onClick={() => void claimVIP()} disabled={busy || !visible || !!refreshRequired}>
                  <Crown size={18} aria-hidden="true" />
                  {t("vip.claimPass")}
                </button>
              : autoContinue
              ? mandatory && !busy && !manualIntent.current && countdownSeconds > 0
                ? <VIPAdCountdown
                    key={`${runtime.getSessionSubjectKey?.() ?? ""}:${offer?.offerId ?? ""}:${vipState.progressDate}:${completedCount}:${countdownSeconds}:${adAttempt}`}
                    seconds={countdownSeconds} visible={visible && !refreshRequired} onStart={startAd}
                  />
                : <span className="vip-continuing" role="status" aria-label={t("gate.preparing")}><span aria-hidden="true" /></span>
              : <button type="button" className="primary-command" onClick={() => { setAutoContinue(true); void watch(true); }} disabled={busy || !visible || !!refreshRequired || error === t("runtime.rewardedAdUnavailable")}>
                  <Play size={18} fill="currentColor" aria-hidden="true" />
                  {busy ? t("vip.playingAd") : t("vip.watchAd")}
                </button>}
          </div>
        )}
      </section>
    </div>
  );
}
