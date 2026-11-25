import { ensureTikTokSDK } from "./sdkReady";
import { logClientEvent } from "../../observability/clientLog";

/** DirectPlayerExemptionRejected 表示 TK 配置明确拒绝当前应用，调用方应按预期拒绝记录。 */
export class DirectPlayerExemptionRejected extends Error {
  /** constructor 固定可诊断的拒绝原因，不携带 Client Key 或 SDK 原始配置。 */
  constructor() {
    super("TikTok explicitly rejects independent playback for this Mini");
    this.name = "DirectPlayerExemptionRejected";
  }
}

interface VideoSecurityInstance {
  /** getConfig 读取当前实例身份与视频校验配置；不读取或输出实例上的密钥。 */
  getConfig(): unknown;
  /** setPlayerVerificationConfig 替换当前页面实例的配置，不改变 Portal 权限。 */
  setPlayerVerificationConfig(config: Record<string, unknown>): void;
  /** isClientKeyBlacklisted 沿用当前 SDK 对显式拒绝列表的判断。 */
  isClientKeyBlacklisted(clientKey: string, config: Record<string, unknown>): boolean;
  /** isClientKeyWhitelisted 确认新配置已由当前 SDK 接纳。 */
  isClientKeyWhitelisted(clientKey: string, config: Record<string, unknown>): boolean;
}

// 同一 SDK 实例共用一次初始化；失败释放任务，重试仍重新核对身份与配置。
const preparations = new WeakMap<VideoSecurityInstance, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readInstance(page: Window): VideoSecurityInstance {
  const instance = page.__ttMinisVideoSecurityInstance;
  if (!isRecord(instance) ||
      typeof instance.getConfig !== "function" ||
      typeof instance.setPlayerVerificationConfig !== "function" ||
      typeof instance.isClientKeyBlacklisted !== "function" ||
      typeof instance.isClientKeyWhitelisted !== "function") {
    throw new Error("TikTok video verification instance is unavailable or unsupported");
  }
  return instance as unknown as VideoSecurityInstance;
}

function readConfig(instance: VideoSecurityInstance, page: Window): {
  clientKey: string;
  verification: Record<string, unknown>;
} {
  const config = instance.getConfig();
  if (!isRecord(config) || typeof config.appId !== "string" || !config.appId.trim() ||
      config.appId.trim() !== page.__TIKTOK_MINIS_CLIENT_KEY__?.trim()) {
    throw new Error("TikTok video verification identity does not match the initialized Mini");
  }
  if (!isRecord(config.playerVerificationConfig)) {
    throw new Error("TikTok video verification configuration is unavailable");
  }
  return { clientKey: config.appId.trim(), verification: config.playerVerificationConfig };
}

/** ensureDirectPlayerExemption 在独立播放器创建前调整当前页面实例；失败由播放器初始化边界记录并传播。 */
export async function ensureDirectPlayerExemption(page: Window = window): Promise<void> {
  await ensureTikTokSDK();
  const instance = readInstance(page);
  const existing = preparations.get(instance);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => {
    if (readInstance(page) !== instance) {
      throw new Error("TikTok video verification instance changed during initialization");
    }
    const { clientKey, verification } = readConfig(instance, page);
    if (instance.isClientKeyBlacklisted(clientKey, verification)) throw new DirectPlayerExemptionRejected();
    const entries = Array.isArray(verification.playerWhiteList) ? [...verification.playerWhiteList] : [];
    if (!entries.includes(clientKey)) entries.push(clientKey);
    // 仅加入当前初始化的 Client Key，保留平台的其他配置与显式拒绝规则。
    instance.setPlayerVerificationConfig({ ...verification, playerWhiteList: entries });
    const applied = readConfig(instance, page);
    if (instance.isClientKeyBlacklisted(clientKey, applied.verification)) throw new DirectPlayerExemptionRejected();
    if (!instance.isClientKeyWhitelisted(clientKey, applied.verification)) {
      throw new Error("TikTok independent player exemption was not applied");
    }
    logClientEvent("info", "direct_player_exemption_ready");
  }).catch(reason => {
    if (preparations.get(instance) === pending) preparations.delete(instance);
    // 独立播放器初始化边界统一记录实际错误，避免同次失败重复输出。
    throw reason;
  });
  preparations.set(instance, pending);
  return pending;
}
