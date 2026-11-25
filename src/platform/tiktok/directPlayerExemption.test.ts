import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DirectPlayerExemptionRejected, ensureDirectPlayerExemption } from "./directPlayerExemption";

const ready = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./sdkReady", () => ({ ensureTikTokSDK: ready }));

function createPage() {
  let verification: Record<string, unknown> = {
    playerWhiteList: ["another-mini"], playerBlackList: ["rejected-mini"],
    privateValue: "token=do-not-log",
  };
  const config = { appId: "current-mini", get playerVerificationConfig() { return verification; } };
  const instance = {
    getConfig: vi.fn(() => config),
    setPlayerVerificationConfig: vi.fn((next: Record<string, unknown>) => { verification = next; }),
    isClientKeyBlacklisted: vi.fn((key: string, value: Record<string, unknown>) =>
      Array.isArray(value.playerBlackList) && value.playerBlackList.includes(key)),
    isClientKeyWhitelisted: vi.fn((key: string, value: Record<string, unknown>) =>
      Array.isArray(value.playerWhiteList) && value.playerWhiteList.includes(key)),
  };
  const page = {
    __TIKTOK_MINIS_CLIENT_KEY__: "current-mini",
    __ttMinisVideoSecurityInstance: instance,
  } as unknown as Window;
  return { page, instance, config, installConfig: (value: Record<string, unknown>) => { verification = value; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  ready.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("官方初始化完成后立即配置独立播放器，无需推进定时器", async () => {
  const fixture = createPage();
  let initialized!: () => void;
  ready.mockImplementationOnce(() => new Promise<void>(resolve => { initialized = resolve; }));
  const pending = ensureDirectPlayerExemption(fixture.page);
  await Promise.resolve();
  expect(fixture.instance.getConfig).not.toHaveBeenCalled();
  fixture.installConfig({ playerWhiteList: ["native-mini"], playerBlackList: ["rejected-mini"], nativeRevision: "latest" });
  initialized();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.config.playerVerificationConfig).toEqual({
    playerWhiteList: ["native-mini", "current-mini"],
    playerBlackList: ["rejected-mini"], nativeRevision: "latest",
  });
});

it("同一 SDK 实例的并发与后续请求共用一次处理，成功日志不带原始配置", async () => {
  const fixture = createPage();
  const first = ensureDirectPlayerExemption(fixture.page);
  const second = ensureDirectPlayerExemption(fixture.page);
  await Promise.all([first, second]);
  await ensureDirectPlayerExemption(fixture.page);
  expect(fixture.instance.setPlayerVerificationConfig).toHaveBeenCalledOnce();
  expect(console.info).toHaveBeenCalledExactlyOnceWith({ event: "direct_player_exemption_ready" });
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/current-mini|privateValue|do-not-log/);
});

it("不支持的 SDK 实例明确失败，不放行播放器", async () => {
  const fixture = createPage();
  fixture.page.__ttMinisVideoSecurityInstance = { getConfig: () => ({}) };
  await expect(ensureDirectPlayerExemption(fixture.page)).rejects.toThrow("unavailable or unsupported");
  expect(fixture.instance.setPlayerVerificationConfig).not.toHaveBeenCalled();
});

it("实例缺失后可以在官方 SDK 恢复时重新尝试", async () => {
  const fixture = createPage();
  delete fixture.page.__ttMinisVideoSecurityInstance;
  await expect(ensureDirectPlayerExemption(fixture.page)).rejects.toThrow("unavailable");
  fixture.page.__ttMinisVideoSecurityInstance = fixture.instance;
  const retry = ensureDirectPlayerExemption(fixture.page);
  await retry;
  expect(fixture.instance.setPlayerVerificationConfig).toHaveBeenCalledOnce();
});

it("初始化期间 SDK 实例更换会作废旧任务，重试绑定新实例", async () => {
  const original = createPage();
  const next = createPage();
  const rejected = expect(ensureDirectPlayerExemption(original.page)).rejects.toThrow("instance changed");
  queueMicrotask(() => { original.page.__ttMinisVideoSecurityInstance = next.instance; });
  await rejected;
  expect(original.instance.setPlayerVerificationConfig).not.toHaveBeenCalled();
  const retry = ensureDirectPlayerExemption(original.page);
  await retry;
  expect(next.instance.setPlayerVerificationConfig).toHaveBeenCalledOnce();
});

it("Client Key 与初始化身份不一致时拒绝修改，修正后可重试", async () => {
  const fixture = createPage();
  fixture.config.appId = "another-mini";
  const rejected = expect(ensureDirectPlayerExemption(fixture.page)).rejects.toThrow("identity does not match");
  await rejected;
  expect(fixture.instance.setPlayerVerificationConfig).not.toHaveBeenCalled();
  fixture.config.appId = "current-mini";
  const retry = ensureDirectPlayerExemption(fixture.page);
  await retry;
});

it("保留平台的显式拒绝，预期拒绝不改写配置", async () => {
  const fixture = createPage();
  fixture.installConfig({ playerWhiteList: [], playerBlackList: ["current-mini"] });
  const rejected = expect(ensureDirectPlayerExemption(fixture.page)).rejects.toBeInstanceOf(DirectPlayerExemptionRejected);
  await rejected;
  expect(fixture.instance.setPlayerVerificationConfig).not.toHaveBeenCalled();
});

it("SDK 未接纳新配置时明确失败，失败任务不会阻止重试", async () => {
  const fixture = createPage();
  fixture.instance.setPlayerVerificationConfig.mockImplementationOnce(() => {});
  const rejected = expect(ensureDirectPlayerExemption(fixture.page)).rejects.toThrow("was not applied");
  await rejected;
  const retry = ensureDirectPlayerExemption(fixture.page);
  await retry;
  expect(fixture.instance.setPlayerVerificationConfig).toHaveBeenCalledTimes(2);
});

it("原生配置尚未就绪时拒绝写入", async () => {
  const fixture = createPage();
  fixture.instance.getConfig.mockReturnValue({ appId: "current-mini", playerVerificationConfig: null } as never);
  const rejected = expect(ensureDirectPlayerExemption(fixture.page)).rejects.toThrow("configuration is unavailable");
  await rejected;
  expect(fixture.instance.setPlayerVerificationConfig).not.toHaveBeenCalled();
});
