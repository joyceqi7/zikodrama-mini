import { afterEach, describe, expect, it, vi } from "vitest";

import { requestSilentLoginCode } from "./login";
import type { TikTokMinisSDK } from "./types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("requestSilentLoginCode", () => {
  it("冷启动桥接超过三秒仍可成功，后台停留不消耗登录额度且不重复登录", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let callback!: (result: { code: string }) => void;
    const sdk = { login: vi.fn(handler => { callback = handler; }) } as unknown as TikTokMinisSDK;
    const failure = vi.fn();
    const pending = requestSilentLoginCode(sdk);
    void pending.catch(failure);
    await vi.advanceTimersByTimeAsync(4000);
    visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failure).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
    callback({ code: "late-but-valid" });
    await expect(pending).resolves.toBe("late-but-valid");
    expect(sdk.login).toHaveBeenCalledOnce();
  });
  it("accepts the callback login contract used by the bundled Minis CLI", async () => {
    const sdk = {
      login: vi.fn(
        (callback: (result: { authResponse: { code: string } }) => void) => {
          callback({ authResponse: { code: "callback-code" } });
        },
      ),
    } as unknown as TikTokMinisSDK;

    await expect(requestSilentLoginCode(sdk)).resolves.toBe("callback-code");
  });

  it("accepts the options login contract and direct code response", async () => {
    const sdk = {
      login: vi.fn((options: { success(result: { code: string }): void }) => {
        options.success({ code: "options-code" });
      }),
    } as unknown as TikTokMinisSDK;

    await expect(requestSilentLoginCode(sdk)).resolves.toBe("options-code");
  });

  it("SDK不回调时按超时拒绝，不继续发送匿名启动请求", async () => {
    vi.useFakeTimers();
    const sdk = { login: vi.fn() } as unknown as TikTokMinisSDK;
    const pending = expect(requestSilentLoginCode(sdk)).rejects.toMatchObject({ code: "request_timeout", status: 0 });
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
  });

  it("SDK同步抛错按平台暂不可用分类，不暴露原始异常", async () => {
    const sdk = {
      login: vi.fn(() => {
        throw new Error("bridge unavailable");
      }),
    } as unknown as TikTokMinisSDK;
    await expect(requestSilentLoginCode(sdk)).rejects.toMatchObject({ code: "identity_unavailable", status: 503 });
  });

  it.each([undefined])("SDK缺失或不支持登录时给出能力缺失分类", async (sdk) => {
    await expect(requestSilentLoginCode(sdk)).rejects.toMatchObject({ code: "identity_unsupported" });
  });

  it("SDK明确失败按平台不可用分类，成功但缺码也不能建立会话", async () => {
    const failed = { login: (options: { fail(result: unknown): void }) => options.fail({ error: { error_msg: "secret" } }) } as unknown as TikTokMinisSDK;
    const missing = { login: (options: { success(result: unknown): void }) => options.success({}) } as unknown as TikTokMinisSDK;
    await expect(requestSilentLoginCode(failed)).rejects.toMatchObject({ code: "identity_unavailable" });
    await expect(requestSilentLoginCode(missing)).rejects.toMatchObject({ code: "identity_unavailable" });
  });

  it("超时后的迟到成功不能重新建立会话", async () => {
    vi.useFakeTimers();
    let callback!: (result: { code: string }) => void;
    const sdk = { login: (handler: typeof callback) => { callback = handler; } } as unknown as TikTokMinisSDK;
    const pending = expect(requestSilentLoginCode(sdk)).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    callback({ code: "late-code" });
    await pending;
  });
});


it.each(["callback"])("登录 %s 失败记录脱敏的实际原因，业务错误仍使用稳定映射", async (kind) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const message = "OAuth bridge offline access_token=private-token url=https://private.example/path";
  const sdk = { login: (options: { fail(result: unknown): void }) => {
    if (kind === "throw") throw new Error(message);
    options.fail({ error: { error_msg: message, error_extra: { password: "private-password" } } });
  } } as unknown as TikTokMinisSDK;
  await expect(requestSilentLoginCode(sdk)).rejects.toMatchObject({ code: "identity_unavailable", message: kind === "throw" ? "Silent login bridge failed" : "Silent login failed" });
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith({ event: "tiktok_silent_login_failed", error: "OAuth bridge offline access_token=[REDACTED] url=[URL]" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
});

it("登录成功不打印错误，也不输出一次性授权码", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const sdk = { login: (callback: (result: { code: string }) => void) => callback({ code: "private-code" }) } as unknown as TikTokMinisSDK;
  await expect(requestSilentLoginCode(sdk)).resolves.toBe("private-code");
  expect(log).not.toHaveBeenCalled();
});
