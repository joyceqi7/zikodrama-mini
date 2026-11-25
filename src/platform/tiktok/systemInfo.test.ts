import { afterEach, expect, it, vi } from "vitest";
import { readTikTokSystemInfo } from "./systemInfo";
import type { TikTokMinisSDK } from "./types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("同步系统信息故障有脱敏日志，仍可使用异步官方能力", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sdk = { canIUse: () => true,
    getSystemInfoSync: () => { throw { errMsg: "sync failed token=private-value https://secret.test" }; },
    getSystemInfo: ({ success }: { success(info: unknown): void }) => success({ platform: "ios", version: "46.1" }),
  } as unknown as TikTokMinisSDK;
  expect(await readTikTokSystemInfo(sdk)).toEqual({ platform: "ios", version: "46.1" });
  expect(warn).toHaveBeenCalledWith({ event: "system_info_sync_failed", error: "sync failed token=[REDACTED] [URL]" });
});

it.each(["capability", "callback", "throw", "timeout"])("系统信息 %s 故障返回未知且保留实际诊断", async mode => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sdk = {
    canIUse: () => { if (mode === "capability") throw new Error("capability failed cookie=private-value"); return true; },
    getSystemInfo: ({ fail }: { fail(reason: unknown): void }) => {
      if (mode === "throw") throw new Error("read failed cookie=private-value");
      if (mode === "callback") fail({ errMsg: "read failed cookie=private-value" });
    },
  } as unknown as TikTokMinisSDK;
  const result = readTikTokSystemInfo(sdk);
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toMatchObject({ error: expect.stringMatching(/failed|timed out/) });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
});

it("成功读取不会误报错误", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sdk = { canIUse: () => true, getSystemInfoSync: () => ({ platform: "android", version: "46.1" }) } as unknown as TikTokMinisSDK;
  expect(await readTikTokSystemInfo(sdk)).toMatchObject({ platform: "android" });
  expect(warn).not.toHaveBeenCalled();
});
