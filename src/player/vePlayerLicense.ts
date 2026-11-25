import configuration from "../config/veplayer-licenses.json";
import { safeErrorMessage } from "../observability/clientLog";

const bundledFiles = import.meta.glob<string>("../assets/veplayer/*.lic", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** VePlayerLicense 绑定页面域名、SDK 应用和未经改写的许可内容。 */
export interface VePlayerLicense {
  /** domain 是配置文件声明的授权域名后缀。 */
  domain: string;
  /** appId 是许可所属的 BytePlus SDK 应用标识，内部始终使用字符串。 */
  appId: string;
  /** license 是交给官方 SDK 验证及自动更新的许可参数。 */
  license: {
    /** content 保留原文件 Content，不改写授权域名或有效期。 */
    content: string;
    /** sign 保留原文件 Signature，由 SDK 验签。 */
    sign: string;
    /** mainUrl 使用同一许可的 MainURL，由 SDK 处理续费和升级更新。 */
    mainUrl: string;
  };
}

/** readTopLevelHostname 读取 SDK 实际验证的顶层域名，跨域不可读时拒绝猜测当前框架域名。 */
export function readTopLevelHostname(page: Pick<Window, "top"> = window): string {
  try {
    const hostname = page.top?.location.hostname;
    if (!hostname) throw new Error("Top-level playback hostname is empty");
    return hostname.toLowerCase().replace(/\.$/, "");
  } catch (reason) {
    // 保留安全处理后的实际读取错误；初始化边界统一记录一次失败。
    throw new Error(`Cannot read top-level playback hostname: ${safeErrorMessage(reason)}`);
  }
}

/** selectVePlayerLicense 按严格域名边界选择随包许可，缺失、错配或无更新地址时拒绝初始化。 */
export function selectVePlayerLicense(
  hostname: string,
  files: Readonly<Record<string, string>> = bundledFiles,
): VePlayerLicense {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // 官方 SDK 为本机域名提供调试权限；仅本机使用明确配置的许可，不向未知生产域名回退。
  const localDebug = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!localDebug && (host.length > 253 || !host.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw new Error("Top-level playback hostname is invalid");
  }
  const binding = configuration.domains.find(({ domain }) => localDebug
    ? domain === configuration.localDebugDomain
    : host === domain || host.endsWith(`.${domain}`));
  if (!binding) throw new Error(`No VePlayer license is configured for the top-level domain: ${host}`);

  const raw = files[`../assets/veplayer/${binding.licenseFile}`];
  if (!raw) throw new Error(`Bundled VePlayer license is missing for ${binding.domain}`);
  // 解析错误不能带出原始 Content、Signature 或 URL；签名的真实性仍由 SDK 验证。
  let envelope: { Content?: unknown; Signature?: unknown; MainURL?: unknown };
  let wildcardDomain: unknown;
  try {
    envelope = JSON.parse(raw);
    wildcardDomain = JSON.parse(atob(envelope.Content as string)).WildcardDomain;
  } catch {
    throw new Error(`Bundled VePlayer license is malformed for ${binding.domain}`);
  }
  if (
    typeof envelope.Content !== "string" || !envelope.Content.trim() ||
    typeof envelope.Signature !== "string" || !envelope.Signature.trim() ||
    wildcardDomain !== `*.${binding.domain}` ||
    !/^[1-9]\d*$/.test(binding.appId) || !Number.isSafeInteger(Number(binding.appId)) ||
    !binding.licenseFile.endsWith(`-a-${binding.appId}.lic`)
  ) throw new Error(`Bundled VePlayer license does not match its configuration for ${binding.domain}`);

  let mainUrl: URL;
  try {
    if (typeof envelope.MainURL !== "string" || !envelope.MainURL.trim()) throw new Error();
    mainUrl = new URL(envelope.MainURL);
    if (mainUrl.protocol !== "https:" || mainUrl.username || mainUrl.password) throw new Error();
  } catch {
    throw new Error(`Bundled VePlayer license has no valid HTTPS MainURL for ${binding.domain}`);
  }
  return {
    domain: binding.domain,
    appId: binding.appId,
    license: { content: envelope.Content, sign: envelope.Signature, mainUrl: envelope.MainURL as string },
  };
}
