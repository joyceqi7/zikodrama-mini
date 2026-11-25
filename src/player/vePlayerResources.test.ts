import { afterEach, beforeEach, expect, it, vi } from "vitest";

const originalWindow = window;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", new Proxy(originalWindow, {
    get(target, property) {
      return property === "top" ? { location: { hostname: "mini.tiktok-minis.us" } } : Reflect.get(target, property, target);
    },
  }));
});

afterEach(() => {
  vi.doUnmock("@byteplus/veplayer");
  vi.doUnmock("@byteplus/veplayer/index.min.css");
  vi.doUnmock("../platform/tiktok/directPlayerExemption");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["SDK", "CSS"])("%s 资源失败时立即诊断，不等待页面校验、不初始化许可或播放器，迟到校验失败不产生未处理拒绝", async failing => {
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  const license = vi.fn(async () => {});
  const created = vi.fn();
  let rejectCheck!: (reason: Error) => void;
  const check = new Promise<void>((_, reject) => { rejectCheck = reject; });
  const exemption = vi.fn(() => check);
  vi.doMock("../platform/tiktok/directPlayerExemption", async () => ({
    ...await vi.importActual<typeof import("../platform/tiktok/directPlayerExemption")>("../platform/tiktok/directPlayerExemption"),
    ensureDirectPlayerExemption: exemption,
  }));
  const failure = new Error(`${failing} chunk unavailable https://private.example/chunk?token=secret token=credential`);
  const sdk = vi.fn(async () => {
    if (failing === "SDK") throw failure;
    return { default: class {
      static setLicenseConfig = license;
      constructor() { created(); }
    } };
  });
  const css = vi.fn(async () => {
    if (failing === "CSS") throw failure;
    return {};
  });
  vi.doMock("@byteplus/veplayer", sdk);
  vi.doMock("@byteplus/veplayer/index.min.css", css);
  const { DirectVePlayerAdapter } = await import("./vePlayerEngine");
  await expect(new DirectVePlayerAdapter().getConstructor()).rejects.toThrow(`${failing} chunk unavailable [URL] token=[REDACTED]`);
  expect(exemption).toHaveBeenCalledOnce();
  expect(sdk).toHaveBeenCalledOnce();
  expect(css).toHaveBeenCalledOnce();
  expect(license).not.toHaveBeenCalled();
  expect(created).not.toHaveBeenCalled();
  expect(logging).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    event: "direct_player_initialization_failed", error: `${failing} chunk unavailable [URL] token=[REDACTED]`,
  }));
  expect(JSON.stringify(logging.mock.calls)).not.toMatch(/secret|credential|https:\/\//);
  rejectCheck(new Error("late page verification failure"));
  // 让较晚失败的并行分支完成，Vitest 同时检查是否出现未处理拒绝。
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(logging).toHaveBeenCalledTimes(1);
});
