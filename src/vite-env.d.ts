/// <reference types="vite/client" />

import type { TikTokMinisSDK } from "./platform/tiktok/types";

interface ImportMetaEnv {
  /** TikTok 官方 AppID，独立于 Client Key 与内部 applicationId。 */
  readonly VITE_TIKTOK_APP_ID?: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_APP_LOGO_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_TIKTOK_CLIENT_KEY?: string;
  /** VITE_MINIS_PREVIEW_BUILD 仅由预览打包设置，正式包在编译期剔除诊断入口。 */
  readonly VITE_MINIS_PREVIEW_BUILD?: "0" | "1";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  /** __MINI_BUILD_ID__ 是当前 Mini 包的公开构建修订，用于回传故障定位。 */
  const __MINI_BUILD_ID__: string;
  /** __MINI_APP_VERSION__ 是人工填写后固化到代码包的三段业务版本。 */
  const __MINI_APP_VERSION__: string;
  interface Window {
    /** __PLAYBACK_PREVIEW_CONSOLE__ 仅由 Sandbox 打包器注入，不通过 URL 或环境变量开启。 */
    __PLAYBACK_PREVIEW_CONSOLE__?: boolean;
    /** VConsole 是 TikTok 官方调试脚本提供的构造器，仅使用日志插件。 */
    VConsole?: new (options: { defaultPlugins: string[]; log: { maxLogNumber: number; showTimestamps: boolean } }) => unknown;
    TTMinis?: TikTokMinisSDK;
    __TIKTOK_MINIS_CLIENT_KEY__?: string;
    __TIKTOK_MINIS_INITIALIZED__?: boolean;
    /** __TIKTOK_MINIS_INITIALIZE__ 保留 CLI 可识别的 Client Key，交由异步加载器调用。 */
    __TIKTOK_MINIS_INITIALIZE__?: () => Promise<void>;
    /** __ttMinisVideoSecurityInstance 是当前公开 SDK 的页面校验实例；使用前必须核对实际接口形态。 */
    __ttMinisVideoSecurityInstance?: unknown;
  }
}

export {};
