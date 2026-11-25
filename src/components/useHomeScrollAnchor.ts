import { useLayoutEffect, useRef } from "react";

/** useHomeScrollAnchor 在后台数据更新前记录可见卡片，布局完成后保持其屏幕位置；已删除时保留最近的存活锚点。 */
export function useHomeScrollAnchor(): () => void {
  const pending = useRef<Array<{ id: string; top: number }> | undefined>(undefined);
  useLayoutEffect(() => {
    const anchors = pending.current;
    pending.current = undefined;
    if (!anchors || window.scrollY === 0) return;
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-home-anchor]"));
    for (const anchor of anchors) {
      const element = elements.find(item => item.dataset.homeAnchor === anchor.id);
      if (!element) continue;
      const delta = element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: "instant" });
      break;
    }
  });
  return () => {
    if (window.scrollY === 0) return;
    pending.current = Array.from(document.querySelectorAll<HTMLElement>("[data-home-anchor]"))
      .filter(element => element.getBoundingClientRect().bottom > 0)
      .map(element => ({ id: element.dataset.homeAnchor!, top: element.getBoundingClientRect().top }));
  };
}
