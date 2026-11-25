import type { TikTokMinisSDK, TikTokSystemAPI, TikTokSystemInfo } from "./types";
import { logClientEvent } from "../../observability/clientLog";
import { platformErrorMessage } from "./errors";

const SYSTEM_INFO_TIMEOUT_MS = 500;

function capabilityAvailable(
  sdk: TikTokMinisSDK,
  system: TikTokSystemAPI,
  capability: "getSystemInfoSync" | "getSystemInfo",
): boolean {
  try {
    if (system.canIUse) return system.canIUse(capability);
    if (sdk.canIUse) {
      return sdk.canIUse(`game.${capability}`) || sdk.canIUse(capability);
    }
  } catch (reason) {
    logClientEvent("warn", "system_info_capability_failed", { error: platformErrorMessage(reason, "System information capability check failed") });
    return false;
  }
  return false;
}

/** 读取 TikTok 客户端版本，不向调用方泄露 SDK 调用差异。 */
export async function readTikTokSystemInfo(
  sdk: TikTokMinisSDK | undefined,
): Promise<TikTokSystemInfo | undefined> {
  if (!sdk) return undefined;
  const system = sdk.game || sdk;

  if (
    system.getSystemInfoSync &&
    capabilityAvailable(sdk, system, "getSystemInfoSync")
  ) {
    try {
      const result = system.getSystemInfoSync();
      if (result.version?.trim()) return result;
    } catch (reason) {
      logClientEvent("warn", "system_info_sync_failed", { error: platformErrorMessage(reason, "Synchronous system information failed") });
      // 继续尝试受能力检测保护的异步 API。
    }
  }

  if (
    !system.getSystemInfo ||
    !capabilityAvailable(sdk, system, "getSystemInfo")
  ) {
    return undefined;
  }

  return new Promise((resolve) => {
    let completed = false;
    const timeout = window.setTimeout(() => {
      logClientEvent("warn", "system_info_timeout", { error: "System information callback timed out" });
      finish(undefined);
    }, SYSTEM_INFO_TIMEOUT_MS);
    const finish = (result: TikTokSystemInfo | undefined) => {
      if (completed) return;
      completed = true;
      window.clearTimeout(timeout);
      resolve(result);
    };

    try {
      system.getSystemInfo!({
        success: finish,
        fail: reason => {
          logClientEvent("warn", "system_info_read_failed", { error: platformErrorMessage(reason, "System information failed") });
          finish(undefined);
        },
      });
    } catch (reason) {
      logClientEvent("warn", "system_info_read_failed", { error: platformErrorMessage(reason, "System information failed") });
      finish(undefined);
    }
  });
}
