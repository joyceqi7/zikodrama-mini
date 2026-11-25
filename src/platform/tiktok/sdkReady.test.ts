import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ensureTikTokSDK } from "./sdkReady";
import { createTikTokFixture } from "../../test/tiktokFixture";
import entryHTML from "../../../index.html?raw";
beforeEach(() => { delete window.TTMinis; delete window.__TIKTOK_MINIS_INITIALIZED__; });
afterEach(() => {
  document.querySelectorAll("script[data-tiktok-sdk]").forEach(script => script.remove());
  delete window.TTMinis; delete window.__TIKTOK_MINIS_INITIALIZE__; delete window.__TIKTOK_MINIS_INITIALIZED__;
  vi.useRealTimers(); vi.restoreAllMocks();
});
it("共享 SDK 就绪任务且不使用 async/defer，官方初始化完成前保持等待", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  let initialize!: () => void;
  window.__TIKTOK_MINIS_INITIALIZE__ = () => new Promise<void>(resolve => { initialize = resolve; });
  const ready = vi.fn();
  const first = ensureTikTokSDK();
  expect(ensureTikTokSDK()).toBe(first);
  void first.then(ready);
  const script = document.querySelector<HTMLScriptElement>("script[data-tiktok-sdk]")!;
  expect(script.async).toBe(false);
  expect(script.defer).toBe(false);
  expect(script.hasAttribute("async")).toBe(false);
  expect(script.hasAttribute("defer")).toBe(false);
  expect(script.src).toBe("https://connect.tiktok-minis.com/drama/sdk.js");
  window.TTMinis = createTikTokFixture().sdk;
  script.dispatchEvent(new Event("load"));
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  initialize();
  await first;
  expect(ready).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledExactlyOnceWith({ event: "tiktok_sdk_ready", elapsedMs: expect.any(Number) });
});
it("加载失败清理任务并记录实际故障，重试可恢复", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const first = ensureTikTokSDK();
  const rejected = expect(first).rejects.toThrow("script failed to load");
  document.querySelector("script[data-tiktok-sdk]")!.dispatchEvent(new Event("error"));
  await rejected;
  expect(document.querySelector("script[data-tiktok-sdk]")).toBeNull();
  const second = ensureTikTokSDK();
  const retryScript = document.querySelector<HTMLScriptElement>("script[data-tiktok-sdk]")!;
  expect(retryScript.async).toBe(false);
  expect(retryScript.hasAttribute("async") || retryScript.hasAttribute("defer")).toBe(false);
  window.TTMinis = createTikTokFixture().sdk;
  document.querySelector("script[data-tiktok-sdk]")!.dispatchEvent(new Event("load"));
  await second;
  expect(log).toHaveBeenCalledWith({ event: "tiktok_sdk_initialize_failed", error: "TikTok SDK script failed to load" });
});
it("超时不无限阻塞登录，且允许再次加载", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const pending = ensureTikTokSDK();
  const rejected = expect(pending).rejects.toMatchObject({ code: "request_timeout" });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ error: "TikTok SDK initialization timed out" }));
  window.TTMinis = createTikTokFixture().sdk;
  await ensureTikTokSDK();
});

it("复用 HTML 接入的官方 SDK，不重复插入脚本", async () => {
  const script = document.createElement("script");
  script.async = false;
  script.dataset.tiktokSdk = "true";
  document.head.append(script);
  const pending = ensureTikTokSDK();
  expect(document.querySelectorAll("script[data-tiktok-sdk]")).toHaveLength(1);
  window.TTMinis = createTikTokFixture().sdk;
  script.dispatchEvent(new Event("load"));
  await pending;
});

it("正式 HTML 首个脚本为官方 SDK，且不携带容器禁止的 async/defer 属性", () => {
  const document = new DOMParser().parseFromString(entryHTML, "text/html");
  const script = document.head.querySelector("script")!;
  expect(script.getAttribute("src")).toBe("https://connect.tiktok-minis.com/drama/sdk.js");
  expect(script.hasAttribute("async")).toBe(false);
  expect(script.hasAttribute("defer")).toBe(false);
});
it("脚本在应用挂载前失败也可立即提示，重试重新加载", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const script = document.createElement("script");
  script.dataset.tiktokSdk = "true";
  script.dataset.failed = "true";
  document.head.append(script);
  await expect(ensureTikTokSDK()).rejects.toThrow("script failed to load");
  expect(document.querySelector("script[data-tiktok-sdk]")).toBeNull();
  expect(log).toHaveBeenCalledOnce();
  const retry = ensureTikTokSDK();
  window.TTMinis = createTikTokFixture().sdk;
  document.querySelector("script[data-tiktok-sdk]")!.dispatchEvent(new Event("load"));
  await retry;
});
