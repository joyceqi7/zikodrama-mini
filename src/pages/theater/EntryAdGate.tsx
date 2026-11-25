import { captureAdIntent, type AdIntent } from "../../platform/tiktok/adIntent";
import { remainingServerTime, parseServerTimestamp } from "../../domain/serverTime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { userMessage } from "../../api/userMessage";
import { PlaybackLaunchPreview } from "../../components/PlaybackLaunchPreview";
import { text } from "../../copy";
import { createRewardClaim } from "../../domain/rewardClaim";
import { entryAdCount } from "../../domain/entryAdProgress";
import type { ClaimResult, EntryAdStatus } from "../../domain/types";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import { getVisibilitySnapshot, observeVisibility, refreshVisibilitySnapshot } from "../../platform/tiktok/lifecycle";
import { useRuntime } from "../../runtime/RuntimeContext";
import { VIPEntryGate } from "./VIPEntryGate";
import { PlaybackGate } from "./PlaybackGate";

interface Props {
  /** children 在门禁放行或首集延后时挂载；重查期间保留解锁上下文。 */
  children: ReactNode;
}

const noAdExperience = () => undefined;
const noAdExperienceSubscription = () => () => {};

type EntryAdVisit = { elapsedMs: number; visibleSince?: number };

function useEntryAdTimePending(visit: EntryAdVisit, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState<{ visit: EntryAdVisit; delayMs: number }>();

  useLayoutEffect(() => {
    let timer: number | undefined;
    let reached = false;
    const schedule = (visible: boolean) => {
      window.clearTimeout(timer);
      const now = performance.now();
      if (!visible) {
        if (visit.visibleSince !== undefined) visit.elapsedMs += now - visit.visibleSince;
        visit.visibleSince = undefined;
        return;
      }
      // 从详情页提交开始累计，配置或资格稍后返回时沿用已停留的前台时间。
      visit.visibleSince ??= now;
      if (!delayMs || reached) return;
      const remaining = delayMs - visit.elapsedMs - (now - visit.visibleSince);
      if (remaining <= 0) {
        reached = true;
        setElapsed({ visit, delayMs });
        return;
      }
      timer = window.setTimeout(() => schedule(refreshVisibilitySnapshot().visible), Math.ceil(remaining));
    };
    const off = observeVisibility(window.TTMinis, schedule);
    schedule(getVisibilitySnapshot().visible);
    return () => { window.clearTimeout(timer); off(); };
  }, [visit, delayMs]);

  return delayMs > 0 && (elapsed?.visit !== visit || elapsed.delayMs !== delayMs);
}

/** EntryAdGate 在详情页前台计时，时间和服务端进度均满足后才自动拉起需要的入剧广告。 */
export function EntryAdGate({ children }: Props) {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const { dramaId = "", episodeId = "" } = useParams();
  const experience = useSyncExternalStore(runtime.subscribeAdExperience ?? noAdExperienceSubscription, runtime.getAdExperience ?? noAdExperience);
  const [status, setStatus] = useState<EntryAdStatus>();
  const [entryCover, setEntryCover] = useState<{ dramaId: string; episodeId: string; url: string }>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(() => getVisibilitySnapshot().visible);
  // 完播或取消后按服务端最新进度继续；只有故障或未知结果停止自动拉起。
  const [attempt, setAttempt] = useState(0);
  const [finishedDelayVisit, setFinishedDelayVisit] = useState<EntryAdVisit>();
  const requestId = useRef(0);
  const busyRef = useRef(false);
  const manualIntent = useRef<AdIntent | undefined>(undefined);
  const foregroundRetry = useRef(false);
  // 原生前台信号可能迟于广告关闭；忙碌时记下检查，不能直接丢弃。
  const foregroundRefreshPending = useRef(false);
  const visibleRef = useRef(visible);
  const statusSubject = useRef<string | undefined>(undefined);
  const statusDrama = useRef<string | undefined>(undefined);
  const routeDrama = useRef(dramaId);
  routeDrama.current = dramaId;
  const routeEpisode = useRef(episodeId);
  routeEpisode.current = episodeId;
  const visit = useRef({ key: `${dramaId}:${episodeId}`, generation: 0 });
  if (visit.current.key !== `${dramaId}:${episodeId}`) visit.current = { key: `${dramaId}:${episodeId}`, generation: visit.current.generation + 1 };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // 所有入口只安装服务端回包；结算结果会撤销旧查询的提交权，防止旧次数覆盖。
  const applyStatus = useCallback((next: EntryAdStatus, preserveError = false) => {
    requestId.current += 1;
    // 只在当前进度回包生效时消费恢复意图；被前台信号替代的旧查询不能提前清除它。
    foregroundRetry.current = false;
    statusSubject.current = runtime.getSessionSubjectKey?.();
    statusDrama.current = dramaId;
    setStatus(next);
    if (!next.enabled || entryAdCount(next) >= next.requiredCount || !next.offer) manualIntent.current = undefined;
    setChecking(false);
    const remaining = remainingServerTime(next);
    if (next.enabled && (parseServerTimestamp(next.validUntil) === undefined || remaining === undefined || remaining <= 0)) {
      logClientEvent("error", "entry_ad_status_invalid", { error: "Entry ad progress has no future validity deadline" });
      setError(text("entryAd.statusError"));
    } else {
      foregroundRefreshPending.current = false;
      setError(current => preserveError && current ? current : next.enabled && entryAdCount(next) < next.requiredCount && !next.offer ? text("entryAd.adUnavailable") : "");
    }
    return next;
  }, [runtime, dramaId]);

  const applySettlement = useCallback((claim: Pick<ClaimResult, "rewardType" | "dramaId" | "entryAdStatus">) => {
    if (claim.rewardType !== "entry_progress" || !claim.entryAdStatus ||
        (claim.dramaId !== dramaId && claim.entryAdStatus.scope !== "user")) return;
    // 展示事实可能在广告播放期间已确认，但回前台会作废旧响应的时间基准。
    // 仅在该回包已无法用于当前决定时补查服务器，不把过期的本地基准当成进度失败。
    if (claim.entryAdStatus.enabled && (remainingServerTime(claim.entryAdStatus) ?? 0) <= 0) {
      logClientEvent("info", "entry_ad_settlement_requires_refresh");
      return;
    }
    return applyStatus(claim.entryAdStatus);
  }, [applyStatus, dramaId]);

  const refresh = useCallback(async (preserveError = false, initial = false): Promise<EntryAdStatus | undefined> => {
    if (routeDrama.current !== dramaId) return;
    const ticket = ++requestId.current;
    const subject = runtime.getSessionSubjectKey?.();
    if (statusRef.current?.enabled !== false) setChecking(true);
    try {
      const episode = routeEpisode.current;
      const entry = initial && runtime.resolvePlaybackEntry ? await runtime.resolvePlaybackEntry(dramaId, episode) : undefined;
      let next = entry?.entryAdStatus ?? await runtime.api.entryAdStatus(dramaId);
      if (next.enabled && next.countBy === "shown" && await runtime.retryPendingAdShows?.("entry_reward")) {
        next = runtime.getConfirmedEntryAdStatus?.(dramaId) ?? await runtime.api.entryAdStatus(dramaId);
      }
      if (ticket !== requestId.current || routeDrama.current !== dramaId || subject !== runtime.getSessionSubjectKey?.()) return;
      if (entry && routeEpisode.current === episode) setEntryCover({ dramaId, episodeId: episode, url: entry.episode.posterUrl || entry.drama.coverUrl });
      applyStatus(next, preserveError);
      return next;
    } catch (reason) {
      logClientEvent("error", "entry_ad_status_failed", { error: safeErrorMessage(reason) });
      if (ticket !== requestId.current || routeDrama.current !== dramaId || subject !== runtime.getSessionSubjectKey?.()) return;
      // 当前查询的真实故障取代旧广告错误，后续前台检查仍保留错误供用户重试。
      foregroundRetry.current = false;
      manualIntent.current = undefined;
      setChecking(true);
      setError(userMessage(reason, text("entryAd.statusError")));
    }
  }, [runtime, dramaId, applyStatus]);

  useEffect(() => {
    foregroundRefreshPending.current = false;
    setStatus(undefined);
    setChecking(true);
    setError("");
    void refresh(false, true);
    return () => { requestId.current += 1; manualIntent.current = undefined; };
  }, [refresh]);

  const statusRef = useRef(status);
  statusRef.current = status;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    visibleRef.current = getVisibilitySnapshot().visible;
    setVisible(visibleRef.current);
    return observeVisibility(window.TTMinis, next => {
      visibleRef.current = next;
      setVisible(next);
      requestId.current += 1;
      // 后台立即封闭旧的当日许可；回前台重查但不卸载播放器或取消连续解锁。
      if (!next && statusRef.current?.enabled !== false) setChecking(true);
      if (next) {
        if (busyRef.current) foregroundRefreshPending.current = true;
        else {
          foregroundRefreshPending.current = false;
          void refreshRef.current(!foregroundRetry.current);
        }
      }
    });
  }, []);


  useEffect(() => {
    let subject = runtime.getSessionSubjectKey?.();
    return runtime.subscribeSessionState?.(() => {
      const next = runtime.getSessionSubjectKey?.();
      if (next === subject) return;
      subject = next;
      foregroundRefreshPending.current = false;
      requestId.current += 1;
      statusSubject.current = undefined;
      manualIntent.current = undefined;
      setStatus(undefined);
      setChecking(true);
      setError("");
      if (next) void refresh();
    });
  }, [runtime, refresh]);

  const waitingForEntry = !status || statusDrama.current !== dramaId || (status.enabled && entryAdCount(status) < status.requiredCount);
  useEffect(() => {
    if (!waitingForEntry) return;
    return runtime.subscribeEntitlements?.(event => {
      if (event.rewardType === "entry_progress" && !busyRef.current &&
          (event.dramaId === dramaId || event.entryAdStatus?.scope === "user")) {
        if (!applySettlement({ ...event, dramaId: event.dramaId || "" })) void refresh();
      }
    });
  }, [runtime, refresh, waitingForEntry, applySettlement, dramaId]);

  useEffect(() => {
    const remaining = status?.enabled ? remainingServerTime(status) : undefined;
    if (remaining === undefined || remaining <= 0) return;
    const timer = window.setTimeout(() => {
      if (busyRef.current || (status && (remainingServerTime(status) ?? 0) > 0)) return;
      // 当日进度截止后重新查询，失败保留恢复入口，不自行清零或判定达标。
      setChecking(true);
      void refresh();
    }, Math.min(2_147_483_647, remaining));
    return () => window.clearTimeout(timer);
  }, [status, refresh]);

  const subject = runtime.getSessionSubjectKey?.();
  const delayKey = `${dramaId}:${subject ?? ""}`;
  const delayVisit = useMemo((): EntryAdVisit => ({ elapsedMs: 0 }), [delayKey]);
  const statusCurrent = !!status && statusDrama.current === dramaId && statusSubject.current === subject;
  const allowed = !checking && statusCurrent && !busyRef.current && (!status.enabled ||
    (entryAdCount(status) >= status.requiredCount && (remainingServerTime(status) ?? 0) > 0));
  const entryAdNeeded = statusCurrent && status.enabled && entryAdCount(status) < status.requiredCount &&
    !!status.offer && (remainingServerTime(status) ?? 0) > 0;
  const vipNeeded = experience?.monetizationPolicy.status === "enabled" && experience.monetizationPolicy.vip.enabled &&
    experience.monetizationPolicy.vip.requireBeforePlayback === true && !experience.vipState.active;
  const delaySeconds = experience?.monetizationPolicy.entryAdDelaySeconds ?? 0;
  const delayConfigured = Number.isInteger(delaySeconds) && delaySeconds >= 4 && delaySeconds <= 300;
  const entryAdTimePending = useEntryAdTimePending(delayVisit, delayConfigured ? delaySeconds * 1_000 : 0);
  const delaying = entryAdTimePending && finishedDelayVisit !== delayVisit && !checking && !error && !busyRef.current &&
    (entryAdNeeded || (allowed && vipNeeded && !experience?.refreshRequired));

  useEffect(() => {
    // 已正常放行的剧场后续跨日重查，直接执行重新生效的门禁。
    if (delayConfigured && allowed && !vipNeeded && !experience?.refreshRequired) setFinishedDelayVisit(delayVisit);
  }, [delayConfigured, delayVisit, allowed, vipNeeded, experience?.refreshRequired]);

  const watch = useCallback(async () => {
    if (busyRef.current || checking || runtime.isFullscreenAdActive?.() || !visible || !status?.offer || (remainingServerTime(status) ?? 0) <= 0 ||
        statusDrama.current !== dramaId || statusSubject.current !== runtime.getSessionSubjectKey?.()) return;
    busyRef.current = true;
    foregroundRetry.current = false;
    setError("");
    const subject = runtime.getSessionSubjectKey?.();
    const generation = visit.current.generation;
    const currentTarget = () => alive.current && visit.current.generation === generation && routeDrama.current === dramaId && subject === runtime.getSessionSubjectKey?.();
    const baseIntent = manualIntent.current ?? captureAdIntent(currentTarget);
    manualIntent.current = undefined;
    const intent: AdIntent = { ...baseIntent, isCurrent: () => baseIntent.isCurrent() && currentTarget() && statusRef.current === status && (remainingServerTime(status) ?? 0) > 0 };
    try {
      if (status.countBy !== "shown" && runtime.hasPendingAdClaim()) {
        const recovered = await runtime.retryPendingAdClaims();
        if (runtime.hasPendingAdClaim()) {
          if (currentTarget()) setError(text("entryAd.claimError"));
          return;
        }
        if (!currentTarget()) return;
        const latest = [...recovered].reverse().find(item => item.rewardType === "entry_progress" && item.entryAdStatus &&
          (item.dramaId === dramaId || item.entryAdStatus.scope === "user"));
        if (!latest || !applySettlement(latest)) await refresh();
        return;
      }
      const claim = createRewardClaim(status.offer, dramaId);
      const result = await runtime.showEntryAd(claim, status.countBy === "shown", intent);
      if (!currentTarget()) return;
      // 提前关闭按服务端进度判断；未达标继续自动拉起，展示计数达标则直接放行。
      if (result.status === "cancelled") {
        const confirmed = result.entryAdStatus ? applySettlement({ rewardType: "entry_progress", dramaId, entryAdStatus: result.entryAdStatus }) : undefined;
        if (!confirmed && currentTarget()) await refresh();
        return;
      }
      // SDK 失败或等待超时不撤销已由服务端确认的展示进度；达标无需重看，原生互斥仍由适配器独立维护。
      const progress = result.entryAdStatus;
      if (status.countBy === "shown" && result.status !== "completed" && progress?.countBy === "shown" &&
          (!progress.enabled || entryAdCount(progress) >= progress.requiredCount)) {
        if (applySettlement({ rewardType: "entry_progress", dramaId, entryAdStatus: progress })) return;
      }
      if (result.status === "unknown") {
        if (currentTarget()) setError(text("runtime.rewardedAdPending"));
        return;
      }
      if (result.status !== "completed") {
        foregroundRetry.current = result.status === "failed" && ["container_unavailable", "container_suspended", "not_visible", "stale_intent"].includes(result.reason ?? "");
        if (currentTarget()) setError(text(result.status === "failed" && result.reason === "client_outdated" ? "runtime.rewardedAdUnavailable" : "entryAd.adUnavailable"));
        return;
      }
      let settled;
      try { settled = await runtime.claimReward(claim); } catch (reason) {
        // 展示已确认就按展示进度判断；未结算的完播仍由原奖励队列恢复。
        if (status.countBy !== "shown") throw reason;
        logClientEvent("warn", "entry_ad_optional_claim_failed", { error: safeErrorMessage(reason) });
        await refresh();
        return;
      }
      if (settled.rewardType !== "entry_progress") {
        logClientEvent("error", "entry_ad_claim_type_mismatch", { error: `unexpected reward type: ${settled.rewardType}` });
        if (currentTarget()) setError(text("entryAd.claimError"));
        return;
      }
      if (!currentTarget()) return;
      // 新版结算直接返回最新进度；旧服务端或无法确认的新字段才复用原查询接口。
      const next = applySettlement(settled) ?? await refresh();
      if (next?.enabled && next.progressDate === status.progressDate && next.scope === status.scope && next.countBy === status.countBy &&
          entryAdCount(next) <= entryAdCount(status)) {
        // 只比较同一天同一模式的进度；跨午夜或切换模式后按新条件继续判断。
        logClientEvent("error", "entry_ad_progress_not_advanced", { error: "Entry ad claim did not advance daily progress" });
        setError(text("entryAd.claimError"));
      }
    } catch (reason) {
      logClientEvent("error", "entry_ad_claim_failed", { error: safeErrorMessage(reason) });
      if (currentTarget()) setError(userMessage(reason, text("entryAd.claimError")));
    } finally {
      busyRef.current = false;
      // 前台切换撤销了忙碌期间的查询时，在广告流程结束后补做一次权威检查。
      // 已安装有效结算回包会清除标记，正常结算仍不额外查询；不重建广告或奖励请求。
      if (foregroundRefreshPending.current && visibleRef.current && currentTarget()) {
        foregroundRefreshPending.current = false;
        logClientEvent("info", "entry_ad_foreground_check_resumed");
        // 回前台可能早于展示事实确认；后续前台查询继续接管恢复意图，直到有效回包生效。
        await refreshRef.current(!foregroundRetry.current);
      }
      setAttempt(value => value + 1);
    }
  }, [runtime, status, checking, visible, refresh, dramaId, applySettlement]);

  useEffect(() => {
    if (!delaying && !checking && status?.enabled && entryAdCount(status) < status.requiredCount && status.offer &&
        (remainingServerTime(status) ?? 0) > 0 && !error && visible) {
      // 跨日重查可能发生在逐集/VIP 广告尚未关闭时，只等待原生广告释放，不并发拉起。
      if (runtime.isFullscreenAdActive?.()) {
        const timer = window.setTimeout(() => setAttempt(value => value + 1), 250);
        return () => window.clearTimeout(timer);
      }
      void watch();
    }
  }, [runtime, status, checking, error, visible, attempt, watch, delaying]);
  // 入剧已达标且正在展示 VIP 门禁时，正常重查只暂停业务，不隐藏弹窗后重播淡入动画。
  // 真实失败、新一天未达标或主体变化仍回到入剧恢复页，不让 VIP 弹窗遮住上游门禁。
  const preserveVIPDialog = checking && !error && !!status && statusDrama.current === dramaId &&
    statusSubject.current === runtime.getSessionSubjectKey?.() && (!status.enabled || entryAdCount(status) >= status.requiredCount) &&
    experience?.monetizationPolicy.status === "enabled" && experience.monetizationPolicy.vip.enabled &&
    experience.monetizationPolicy.vip.requireBeforePlayback === true && !experience.vipState.active;

  // 手动重试先读取最新进度和 Offer，迟到的展示/领奖可能已经达标，不能直接重复请求广告。
  return <PlaybackGate key={delayKey} allowed={allowed || delaying} entryAdDelay={delaying} entryAdTimePending={entryAdTimePending}
    preserveContent={preserveVIPDialog} fallback={<PlaybackLaunchPreview
    runtime={runtime}
    dramaId={dramaId}
    episodeId={episodeId}
    coverUrl={entryCover?.dramaId === dramaId && entryCover.episodeId === episodeId ? entryCover.url : undefined}
    deferCoverLookup={!!runtime.resolvePlaybackEntry}
    identityReady
    error={error}
    errorDetail={error && status?.enabled ? text("entryAd.progress", { completed: Math.min(entryAdCount(status), status.requiredCount), required: status.requiredCount }) : undefined}
    onRetry={error && error !== text("runtime.rewardedAdUnavailable") ? () => { const subject = runtime.getSessionSubjectKey?.(); manualIntent.current = captureAdIntent(() => routeDrama.current === dramaId && subject === runtime.getSessionSubjectKey?.(), true); void refresh(false, !statusCurrent); } : undefined}
    onBack={error ? () => navigate("/", { replace: true }) : undefined}
  />}>
    {/* VIP 策略变化也复用同一门禁层，避免在 Fragment 与 VIP 包装之间切换而卸载剧场。 */}
    {experience ? <VIPEntryGate>{children}</VIPEntryGate> : children}
  </PlaybackGate>;
}
