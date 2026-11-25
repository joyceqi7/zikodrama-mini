/** ApplicationProfileEnvironment 只接收当前构建包的公开配置，不接收平台密钥。 */
export interface ApplicationProfileEnvironment {
  /** VITE_TIKTOK_APP_ID 是 TikTok 官方 AppID，不是内部 applicationId 或业务编码。 */
  VITE_TIKTOK_APP_ID?: string;
  /** VITE_APP_NAME 是默认展示名称。 */
  VITE_APP_NAME?: string;
  /** VITE_APP_LOGO_URL 是默认公开图标。 */
  VITE_APP_LOGO_URL?: string;
  /** VITE_TIKTOK_CLIENT_KEY 只供官方 SDK 使用，与 AppID 独立配置。 */
  VITE_TIKTOK_CLIENT_KEY?: string;
  /** VITE_API_BASE_URL 是消费者 API 地址。 */
  VITE_API_BASE_URL?: string;
}

/** ApplicationProfile 将包内公开身份与 API、SDK 配置分开保存。 */
export interface ApplicationProfile {
  /** tiktokAppId 是官方 AppID，保持原始字符串及前导零。 */
  tiktokAppId: string;
  /** name 是默认展示名称。 */
  name: string;
  /** logoUrl 是默认公开图标。 */
  logoUrl: string;
  /** clientKey 是官方 SDK Client Key，不能代替 AppID。 */
  clientKey: string;
  /** apiBaseUrl 是消费者 API 地址。 */
  apiBaseUrl: string;
}

function value(input: string | undefined, fallback = ""): string {
  return input?.trim() || fallback;
}

/** resolveApplicationProfile 校验构建身份，禁止将数字转为字符串后掩盖精度丢失。 */
export function resolveApplicationProfile(
  environment: ApplicationProfileEnvironment,
): ApplicationProfile {
  const configuredId = environment.VITE_TIKTOK_APP_ID;
  const tiktokAppId = typeof configuredId === "string" ? configuredId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(tiktokAppId)) {
    throw new Error("VITE_TIKTOK_APP_ID is required and must be a TikTok AppID string");
  }
  return {
    tiktokAppId,
    name: value(environment.VITE_APP_NAME, "Drama Minis"),
    logoUrl: value(environment.VITE_APP_LOGO_URL),
    clientKey: value(environment.VITE_TIKTOK_CLIENT_KEY),
    apiBaseUrl: value(environment.VITE_API_BASE_URL),
  };
}

/** currentApplicationProfile 在所有环境读取并校验包内官方 AppID。 */
export function currentApplicationProfile(): ApplicationProfile {
  return resolveApplicationProfile(import.meta.env as ApplicationProfileEnvironment);
}
