import { afterEach, expect, it, vi } from "vitest";
import { installPreviewConsole } from "./previewConsole";

afterEach(() => {
  window.dispatchEvent(new Event("load"));
  document.querySelectorAll<HTMLScriptElement>("script[data-playback-preview-console]").forEach(script => {
    script.dispatchEvent(new Event("error"));
    script.remove();
  });
  delete window.__PLAYBACK_PREVIEW_CONSOLE__;
  delete window.VConsole;
  vi.restoreAllMocks();
});

it("页面加载完成前不下载诊断脚本，慢加载不阻塞启动且重复调用共用一次下载", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
  window.__PLAYBACK_PREVIEW_CONSOLE__ = true;
  installPreviewConsole();
  installPreviewConsole();
  expect(document.querySelector("script[data-playback-preview-console]")).toBeNull();
  window.dispatchEvent(new Event("load"));
  installPreviewConsole();
  const scripts = document.querySelectorAll<HTMLScriptElement>("script[data-playback-preview-console]");
  expect(scripts).toHaveLength(1);
  expect(scripts[0].async).toBe(true);
  expect(scripts[0].src).toBe("https://connect.tiktok-minis.com/libs/vConsole.js");
  expect(warning).not.toHaveBeenCalled();
  const constructor = vi.fn(function () {});
  window.VConsole = constructor;
  scripts[0].dispatchEvent(new Event("load"));
  expect(constructor).toHaveBeenCalledExactlyOnceWith({ defaultPlugins: ["system"], log: { maxLogNumber: 300, showTimestamps: true } });
});

it("正常包不会初始化手机调试面板，Sandbox 只打开日志插件", () => {
  const constructor = vi.fn(function () {});
  window.VConsole = constructor;
  installPreviewConsole();
  expect(constructor).not.toHaveBeenCalled();
  window.__PLAYBACK_PREVIEW_CONSOLE__ = true;
  installPreviewConsole();
  expect(constructor).toHaveBeenCalledExactlyOnceWith({ defaultPlugins: ["system"], log: { maxLogNumber: 300, showTimestamps: true } });
});

it("调试脚本缺失或初始化失败时保留脱敏原因，不中断应用启动", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  window.__PLAYBACK_PREVIEW_CONSOLE__ = true;
  expect(installPreviewConsole).not.toThrow();
  expect(warning).not.toHaveBeenCalled();
  document.querySelector("script[data-playback-preview-console]")!.dispatchEvent(new Event("error"));
  expect(warning).toHaveBeenCalledWith({ event: "preview_console_unavailable", error: "TikTok preview console script did not load" });
  window.VConsole = function () { throw new Error("Console mount failed token=private https://private.test"); } as unknown as NonNullable<Window["VConsole"]>;
  expect(installPreviewConsole).not.toThrow();
  expect(warning).toHaveBeenLastCalledWith({ event: "preview_console_unavailable", error: "Console mount failed token=[REDACTED] [URL]" });
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
});

it("异步脚本未提供构造器时记录原因，下载失败后仍可重试", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  window.__PLAYBACK_PREVIEW_CONSOLE__ = true;
  installPreviewConsole();
  document.querySelector("script[data-playback-preview-console]")!.dispatchEvent(new Event("error"));
  installPreviewConsole();
  const scripts = document.querySelectorAll("script[data-playback-preview-console]");
  expect(scripts).toHaveLength(2);
  expect(() => scripts[1].dispatchEvent(new Event("load"))).not.toThrow();
  expect(warning).toHaveBeenCalledTimes(2);
  expect(warning).toHaveBeenLastCalledWith({ event: "preview_console_unavailable", error: "TikTok preview console script did not load" });
});

it("宿主拒绝插入诊断脚本时仍继续启动，并保留脱敏原因", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(document.head, "append").mockImplementation(() => { throw new Error("Script rejected token=private https://private.test"); });
  window.__PLAYBACK_PREVIEW_CONSOLE__ = true;
  expect(installPreviewConsole).not.toThrow();
  expect(warning).toHaveBeenCalledWith({ event: "preview_console_unavailable", error: "Script rejected token=[REDACTED] [URL]" });
});
