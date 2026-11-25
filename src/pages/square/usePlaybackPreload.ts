import { resumeEpisodeId } from "../../domain/resumePlayback";
import { useEffect, type RefObject } from "react";
import type { PlaybackSource } from "../../player";
import type { Runtime } from "../../runtime/runtime";
import { logClientEvent, safeErrorMessage } from "../../observability/clientLog";
import { getVisibilitySnapshot, observeVisibility } from "../../platform/tiktok/lifecycle";

/** usePlaybackPreload 为可见主候选准备视频；按下或聚焦时立即准备目标，候选失败互不阻塞。 */
export function usePlaybackPreload(root: RefObject<HTMLElement | null>, runtime: Runtime, enabled: boolean, subjectKey?: string): void {
  useEffect(() => {
    const element = root.current;
    // 独立普通版无法消费首页媒体预热，不为未点选的卡片请求播放授权。
    if (!enabled || !element || !runtime.preloadMedia || runtime.canPreloadMedia?.() === false) return;
    let active = true;
    let visible = getVisibilitySnapshot().visible;
    let revision = 0;
    let candidates: HTMLElement[] = [];
    const observed = new Set<HTMLElement>();
    const onscreen = new Map<HTMLElement, number>();
    const sources = new Map<string, PlaybackSource>();
    const key = (card: HTMLElement) => JSON.stringify([card.dataset.preloadDrama, card.dataset.preloadEpisode]);
    const publish = () => {
      if (!active || !visible) return;
      const ready = candidates.flatMap(card => sources.has(key(card)) ? [sources.get(key(card))!] : []);
      if (ready.length) void runtime.preloadMedia!(ready, 0).catch(error => {
        logClientEvent("warn", "home_preload_failed", { error: safeErrorMessage(error) });
      });
    };
    const select = (priority?: HTMLElement) => {
      if (!active || !visible) return;
      const ranked = [...onscreen].sort((a, b) => b[1] - a[1]).map(([card]) => card);
      // 主候选独立预热，慢封面不阻断；明确意图只准备用户选择的集。
      const seen = new Set<string>();
      const next = (priority ? [priority] : ranked).filter(card => {
        const id = key(card);
        if (seen.has(id)) return false;
        seen.add(id); return true;
      }).slice(0, 1);
      if (next.map(key).join() === candidates.map(key).join()) return;
      candidates = next;
      const ticket = ++revision;
      sources.clear();
      if (!next.length) { runtime.clearMediaPreload?.(); return; }
      // 每个结果到达即交给媒体预加载，不等待同批其他授权。
      for (const card of next) {
        const dramaId = card.dataset.preloadDrama!;
        // 续播卡片预取同一主体最近观看的分集，避免进入播放器前仍下载首集。
        const episodeId = card.dataset.preloadResume === "true"
          ? resumeEpisodeId(runtime.localLibrary.history(), dramaId, card.dataset.preloadEpisode!)
          : card.dataset.preloadEpisode!;
        void (runtime.resolvePlayback?.(dramaId, episodeId) ?? runtime.api.resolvePlay(dramaId, episodeId)).then(result => {
          if (!active || !visible || ticket !== revision) return;
          const media = result.status === "playable" ? result.playback :
            (result.status === "access_required" || result.status === "reward_ad_required") ? result.preload : undefined;
          if (!media) return;
          sources.set(key(card), media);
          publish();
        }).catch(error => logClientEvent("warn", "home_preload_failed", { error: safeErrorMessage(error) }));
      }
    };
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) onscreen.set(card, entry.intersectionRatio);
        else onscreen.delete(card);
      }
      select();
    }, { threshold: [0, 0.5, 1] });
    const scan = () => {
      for (const card of observed) if (!element.contains(card)) { observer?.unobserve(card); observed.delete(card); onscreen.delete(card); }
      element.querySelectorAll<HTMLElement>("[data-preload-drama][data-preload-episode]").forEach(card => {
        if (!observed.has(card)) { observed.add(card); observer?.observe(card); }
      });
      select();
    };
    const mutations = new MutationObserver(scan);
    mutations.observe(element, { childList: true, subtree: true });
    scan();
    const prioritize = (event: Event) => {
      const card = (event.target as Element).closest<HTMLElement>("[data-preload-drama][data-preload-episode]");
      if (card && element.contains(card)) select(card);
    };
    element.addEventListener("pointerdown", prioritize);
    element.addEventListener("focusin", prioritize);
    const reset = () => { ++revision; candidates = []; sources.clear(); };
    const off = observeVisibility(window.TTMinis, value => {
      visible = value; reset();
      if (value) select(); else runtime.clearMediaPreload?.();
    });
    const unsubscribe = runtime.subscribeEntitlements?.(() => { reset(); select(); });
    return () => {
      active = false; ++revision;
      observer?.disconnect(); mutations.disconnect(); off(); unsubscribe?.();
      element.removeEventListener("pointerdown", prioritize);
      element.removeEventListener("focusin", prioritize);
      // 进入剧场继续消费已提交的媒体缓冲；未完成授权仍留在 runtime 供进页复用。
      if (!window.location.hash.startsWith("#/watch/")) runtime.clearMediaPreload?.();
    };
  }, [root, runtime, enabled, subjectKey]);
}
