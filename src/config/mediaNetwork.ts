import { mediaCDNOrigin } from "./brand";

/** mediaCDNOrigin 是播放入口预连接的媒体 CDN HTTPS 地址，按应用包配置。 */
export { mediaCDNOrigin };

function preconnect(origin: string): void {
  if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.crossOrigin = "anonymous";
  link.href = origin;
  document.head.append(link);
}

/** preconnectMediaCDN 为两种播放器共用的媒体 CDN 提前建连，不下载媒体。 */
export function preconnectMediaCDN(): void {
  preconnect(mediaCDNOrigin);
}

/** preconnectDirectMediaInfo 在可信直连通道选定后为固定版 Full SDK 的媒体信息查询提前建连。 */
export function preconnectDirectMediaInfo(): void {
  preconnect("https://vod.byteplusapi.com");
}
