/** coverThumbnail 仅缩放未签名的官方 VOD 原图模板，保留其他来源和带签名地址；调用方须在失败时回退原图。 */
export function coverThumbnail(source: string, width: number): string {
  // 白名单模板避免改写已裁剪封面、非 VOD 图片及签名路径。
  if (!/^https:\/\/[^/?#@]+\/[^?#]+~tplv-vod-(?:noop|obj)\.(?:image|jpeg|webp)$/.test(source)) return source;
  return source.replace(/~tplv-vod-(?:noop|obj)\.(?:image|jpeg|webp)$/, `~tplv-vod-rs:${width}:0.webp`);
}
