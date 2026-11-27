/**
 * 按应用包注入的公开品牌与合规信息。同一份代码给多个小程序打包时，各应用的法律主体、
 * 联系邮箱、适用法律和 BytePlus CDN 域名可能不同；未配置时沿用 ZikoDrama 的取值。
 */
const environment = import.meta.env as Record<string, string | undefined>;

function configured(name: string, fallback: string): string {
  return environment[name]?.trim() || fallback;
}

/** legalEntity 是隐私政策与服务条款中署名的运营主体，须与 TikTok 企业认证一致。 */
export const legalEntity = configured("VITE_LEGAL_ENTITY", "SAILSON PTE LTD");

/** supportEmail 是用户联系、数据删除和版权投诉的公开邮箱。 */
export const supportEmail = configured("VITE_SUPPORT_EMAIL", "support@zikodrama-tv.com");

/** governingLaw 是服务条款适用法律的法域名称，随法律主体所在地变化。 */
export const governingLaw = configured("VITE_GOVERNING_LAW", "Singapore");

/** mediaCDNOrigin 是该应用 BytePlus 空间绑定的视频 CDN HTTPS 地址。 */
export const mediaCDNOrigin = configured("VITE_MEDIA_CDN_ORIGIN", "https://vod.zikodrama-tv.com");

/** imageCDNOrigin 是该应用 BytePlus 空间绑定的封面图片 CDN HTTPS 地址。 */
export const imageCDNOrigin = configured("VITE_IMAGE_CDN_ORIGIN", "https://img.zikodrama-tv.com");
