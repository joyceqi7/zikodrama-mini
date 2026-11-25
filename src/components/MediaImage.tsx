import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { coverLoader, type CoverResource, type CoverState } from "./coverLoader";

/** MediaImage 共享资源任务；懒加载图片接近可视区才入队，解码或失败后通知轮播。 */
export function MediaImage({ src, className = "", loading, fetchPriority, decoding, onSettled, sizes }: {
  /** src 保留完整来源与资源版本，不输出到日志。 */
  src: string;
  /** className 沿用页面尺寸和布局。 */
  className?: string;
  /** loading 为 lazy 时延迟屏外请求，并保留浏览器原生懒加载提示。 */
  loading?: "eager" | "lazy";
  /** fetchPriority 设置共享任务的调度优先级。 */
  fetchPriority?: "high" | "low" | "auto";
  /** decoding 控制展示节点解码策略。 */
  decoding?: "async" | "sync" | "auto";
  /** onSettled 通知图片已解码或已显示失败兜底。 */
  onSettled?: () => void;
  /** sizes 存在时使用统一 480px 卡片封面，跨展示位置复用。 */
  sizes?: string;
  /** maxThumbnailWidth 保留调用方尺寸上限；卡片统一请求不超过 480px。 */
  maxThumbnailWidth?: 480 | 720;
}) {
  const normalized = src.trim();
  const [snapshot, setSnapshot] = useState<{ source: string; state: CoverState }>({ source: "", state: { status: "queued" } });
  const imageNode = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(loading !== "lazy");
  const resource = useRef<CoverResource | undefined>(undefined);
  const callback = useRef(onSettled);
  callback.current = onSettled;
  useEffect(() => {
    if (loading !== "lazy" || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const node = imageNode.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setNearViewport(true);
      observer.disconnect();
    }, { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading]);
  useEffect(() => {
    if (!normalized) { callback.current?.(); return; }
    if (!nearViewport) return;
    const entry = coverLoader.request(normalized, fetchPriority ?? (loading === "lazy" ? "low" : "auto"), Boolean(sizes));
    resource.current = entry;
    let notified = false;
    const update = () => {
      const state = entry.snapshot();
      setSnapshot({ source: normalized, state });
      if (!notified && (state.status === "ready" || state.status === "error")) { notified = true; callback.current?.(); }
    };
    const off = entry.subscribe(update);
    update();
    return () => { off(); resource.current = undefined; };
  }, [normalized, Boolean(sizes), fetchPriority, loading, nearViewport]);
  const state = snapshot.source === normalized ? snapshot.state : { status: "queued" as const };
  if (!normalized || state.status === "error") return <span className={`${className} media-image-placeholder`.trim()} aria-hidden="true"><ImageOff size={20} /></span>;
  const imageClassName = `${className}${state.status === "ready" ? "" : " media-image-loading"}`.trim();
  return <img ref={imageNode} src={state.src} alt="" className={imageClassName || undefined} loading={loading ?? "eager"} fetchPriority={fetchPriority} decoding={decoding ?? "async"}
    onLoad={event => {
      const entry = resource.current;
      const image = event.currentTarget;
      // 下载结束不等于解码结束；旧源的迟到完成不能通知当前卡片。
      if (image.decode) void image.decode().then(() => entry?.settle(true), () => entry?.settle(false));
      else entry?.settle(true);
    }} onError={() => resource.current?.settle(false)} />;
}
