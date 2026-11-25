import { afterEach, describe, expect, it, vi } from "vitest";

import type { TikTokMinisSDK } from "../platform/tiktok/types";
import { OfficialTikTokMinisPlayerAdapter } from "../player/tiktokMinisPlayerAdapter";
import { logClientEvent, safeErrorMessage } from "./clientLog";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("客户端日志脱敏", () => {
  it.each([
    "Cookie: a=private-first; session=private-second",
    "cOoKiE = a=private-first; session=private-second",
    '"Cookie": "a=private-first; session=private-second"',
    '"Cookie": "a=private-first; session=\\"two private-second\\""',
    "Set-Cookie: session=private-first; HttpOnly; Path=/",
    "Cookie:",
  ])("完整隐藏多值 Cookie 字段并保留后续行的故障说明：%s", header => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = `SDK request failed\n${header}\nbridge unavailable`;
    logClientEvent("error", "ad_failed", { error: message, innerError: message });
    const logs = JSON.stringify(error.mock.calls);
    expect(logs).not.toContain("private-");
    expect(logs).toContain("SDK request failed");
    expect(logs).toContain("bridge unavailable");
    expect(logs).toContain("[REDACTED]");
    expect(safeErrorMessage(safeErrorMessage(message))).toBe(safeErrorMessage(message));
  });

  it("保留操作失败原因，仅隐藏消息中的凭据和媒体地址", () => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reason = new Error("Catalog timeout token=private-token url=https://media.example/video?signature=private-signature");
    logClientEvent("error", "catalog_failed", { error: safeErrorMessage(reason) });
    expect(logging).toHaveBeenCalledWith({ event: "catalog_failed", error: "Catalog timeout token=[REDACTED] url=[URL]" });
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private-");
    expect(safeErrorMessage('OAuth failed: "access_token": "private-token"')).toBe('OAuth failed: "access_token": [REDACTED]');
    expect(safeErrorMessage('Report rejected open_id=private-viewer')).toBe('Report rejected open_id=[REDACTED]');
  });

  it("成功诊断不会误写错误日志", () => {
    const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logClientEvent("info", "catalog_loaded");
    expect(logging).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith({ event: "catalog_loaded" });
  });
  it("官方 Player 初始化失败时不记录原始 Token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new OfficialTikTokMinisPlayerAdapter(() => ({
      getPlayer: vi.fn().mockRejectedValue({
        name: "SDKError",
        error_msg: "Player initialization timed out token=must-not-appear",
        playAuthToken: "must-not-appear",
      }),
    }) as unknown as TikTokMinisSDK);

    await expect(adapter.getConstructor()).rejects.toBeTruthy();

    expect(JSON.stringify(error.mock.calls)).not.toContain("must-not-appear");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: "player_constructor_failed",
      error: "Player initialization timed out token=[REDACTED]",
    }));
  });
});
