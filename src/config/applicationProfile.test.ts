import { afterEach, expect, it, vi } from "vitest";

import { currentApplicationProfile, resolveApplicationProfile } from "./applicationProfile";

afterEach(() => vi.unstubAllEnvs());

it("缺少 AppID 时不能生成演示身份", () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_TIKTOK_APP_ID", "");
  vi.stubEnv("VITE_DEMO_MODE", "true");
  expect(() => currentApplicationProfile()).toThrow(/VITE_TIKTOK_APP_ID/);
});

it("官方 AppID 保留前导零和长数字，Client Key 独立配置", () => {
  const profile = resolveApplicationProfile({ VITE_TIKTOK_APP_ID: " 0009007199254740993123 ", VITE_TIKTOK_CLIENT_KEY: "sdk-client-key" });
  expect(profile.tiktokAppId).toBe("0009007199254740993123");
  expect(profile.clientKey).toBe("sdk-client-key");
  expect(profile).not.toHaveProperty("code");
});

it("拒绝旧字段和不合法的应用配置", () => {
  for (const environment of [{ VITE_APP_CODE: "business-code" }, { VITE_TIKTOK_APP_ID: "bad/id" }]) {
    expect(() => resolveApplicationProfile(environment)).toThrow(/VITE_TIKTOK_APP_ID/);
  }
});
