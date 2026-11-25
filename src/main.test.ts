import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";

function renderPackagedBody(): void {
  const html = readFileSync("index.html", "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  document.body.replaceChildren(page.getElementById("root")!);
}

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  runtime: {
    bootstrap: vi.fn(async () => { fixture.events.push("bootstrap"); }),
    preparePlayback: vi.fn(async () => { fixture.events.push("playback"); }),
    prefetchAppConfig: vi.fn(async () => undefined),
    whenPlatformReady: vi.fn(async () => undefined),
    prefetchHome: vi.fn(async () => undefined),
    getCachedHomeSections: vi.fn(),
  },
  createRuntime: vi.fn(),
  mount: vi.fn(),
  home: vi.fn(),
  theater: vi.fn(() => { fixture.events.push("theater"); }),
}));
vi.mock("./runtime/runtime", () => ({ createRuntime: fixture.createRuntime }));
vi.mock("./runtime/theaterModule", () => ({ preloadTheaterModule: fixture.theater }));
vi.mock("./runtime/initialAppConfig", () => ({ prepareInitialAppConfig: vi.fn() }));
vi.mock("./config/applicationProfile", () => ({ currentApplicationProfile: () => ({ name: "TV" }) }));
vi.mock("./observability/previewConsole", () => ({ installPreviewConsole: vi.fn() }));
vi.mock("./platform/tiktok/leftEdgeGestureGuard", () => ({ installLeftEdgeGestureGuard: vi.fn() }));
vi.mock("./components/homeImagePreload", () => ({ preloadHomeCovers: vi.fn() }));

// 每项用全新的入口模块模拟真实页面启动，测试替身不进入业务入口。
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./mountApplication");
  vi.doUnmock("./pages/square");
  fixture.events.length = 0;
  document.body.replaceChildren();
  document.head.querySelector('meta[name="minis-preview-campaign"]')?.remove();
  window.history.replaceState({}, "", "/");
});

it("投放身份和播放器准备先启动，之后才请求 React 挂载模块", async () => {
  window.history.replaceState({}, "", "/?campaignCode=campaign-1");
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  vi.doMock("./mountApplication", () => {
    fixture.events.push("ui-module");
    return { mountApplication: fixture.mount };
  });
  const homeModule = vi.fn(() => ({ SquarePage: fixture.home }));
  vi.doMock("./pages/square", homeModule);
  await import("./entry");
  await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  expect(fixture.events).toEqual(["bootstrap", "theater", "playback", "ui-module"]);
  expect(fixture.mount).toHaveBeenCalledWith(fixture.runtime, expect.objectContaining({ runtime: fixture.runtime, bootstrap: expect.any(Promise), playback: expect.any(Promise) }), undefined);
  expect(homeModule).not.toHaveBeenCalled();
});

it("投放入口在 UI 模块尚未返回时并行准备身份和播放器，跳过品牌中间页", async () => {
  renderPackagedBody();
  window.history.replaceState({}, "", "/?campaignCode=campaign-1");
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  let finish!: (value: { mountApplication: typeof fixture.mount }) => void;
  vi.doMock("./mountApplication", () => new Promise(resolve => { finish = resolve; }));
  try {
    await import("./entry");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(document.getElementById("root")).toBeEmptyDOMElement();
    expect(fixture.runtime.bootstrap).toHaveBeenCalledOnce();
    expect(fixture.runtime.preparePlayback).toHaveBeenCalledOnce();
    expect(fixture.mount).not.toHaveBeenCalled();
  } finally {
    finish?.({ mountApplication: fixture.mount });
    await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  }
});

it("投放预览包从无参数的二维码入口走完整投放启动，跳过首页预取", async () => {
  vi.stubEnv("VITE_MINIS_PREVIEW_BUILD", "1");
  renderPackagedBody();
  const meta = document.createElement("meta");
  meta.name = "minis-preview-campaign";
  meta.content = "campaign-preview";
  document.head.append(meta);
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  vi.doMock("./mountApplication", () => ({ mountApplication: fixture.mount }));

  await import("./entry");
  await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  expect(window.location.search).toBe("?campaignCode=campaign-preview");
  const { prepareInitialAppConfig } = await import("./runtime/initialAppConfig");
  expect(prepareInitialAppConfig).toHaveBeenCalledWith({ name: "TV" }, "?campaignCode=campaign-preview");
  expect(fixture.runtime.preparePlayback).toHaveBeenCalledOnce();
  expect(fixture.runtime.prefetchHome).not.toHaveBeenCalled();
});

it("正式包忽略预览标记并启动普通首页", async () => {
  vi.stubEnv("VITE_MINIS_PREVIEW_BUILD", "0");
  renderPackagedBody();
  const meta = document.createElement("meta");
  meta.name = "minis-preview-campaign";
  meta.content = "campaign-preview";
  document.head.append(meta);
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  vi.doMock("./mountApplication", () => ({ mountApplication: fixture.mount }));
  vi.doMock("./pages/square", () => ({ SquarePage: fixture.home }));

  await import("./entry");
  await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  expect(window.location.search).toBe("");
  expect(fixture.runtime.prefetchHome).toHaveBeenCalledOnce();
  expect(fixture.runtime.preparePlayback).not.toHaveBeenCalled();
  const { installPreviewConsole } = await import("./observability/previewConsole");
  expect(installPreviewConsole).not.toHaveBeenCalled();
});

it("投放封面在启动身份前插入，登录与播放器准备随后照常发起", async () => {
  renderPackagedBody();
  window.history.replaceState({}, "", "/?campaignCode=campaign-preview&coverDramaId=663&coverEpisodeId=18426&coverKey=covers%2Fmain.jpg&coverTitle=Vengeance+Of+The+Duke&coverEpisodeNumber=1&coverEpisodeCount=20");
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  vi.doMock("./mountApplication", () => ({ mountApplication: fixture.mount }));
  const { prepareInitialAppConfig } = await import("./runtime/initialAppConfig");
  vi.mocked(prepareInitialAppConfig).mockImplementationOnce(() => {
    const image = document.querySelector("img[data-campaign-entry-cover]")!;
    expect(image).toHaveAttribute("src", "https://img.zikodrama-tv.com/covers/main.jpg");
    expect(image.parentElement).toHaveAttribute("hidden");
    fireEvent.load(image);
    expect(image.parentElement).not.toHaveAttribute("hidden");
    expect(image.parentElement).toHaveTextContent("Vengeance Of The Duke");
    expect(image.parentElement).toHaveTextContent("Episode 1 of 20");
  });
  await import("./entry");
  await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  expect(prepareInitialAppConfig).toHaveBeenCalledOnce();
  expect(fixture.runtime.bootstrap).toHaveBeenCalledOnce();
  expect(fixture.runtime.preparePlayback).toHaveBeenCalledOnce();
});

it("普通入口并行请求首页和挂载模块，首屏直接使用已加载的首页组件", async () => {
  renderPackagedBody();
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  const homeModule = vi.fn(() => ({ SquarePage: fixture.home }));
  vi.doMock("./pages/square", homeModule);
  let finish!: (value: { mountApplication: typeof fixture.mount }) => void;
  vi.doMock("./mountApplication", () => new Promise(resolve => { finish = resolve; }));
  try {
    await import("./entry");
    await waitFor(() => {
      expect(homeModule).toHaveBeenCalledOnce();
      expect(finish).toBeTypeOf("function");
      expect(fixture.runtime.prefetchHome).toHaveBeenCalledOnce();
    });
    expect(document.getElementById("root")).toBeEmptyDOMElement();
    expect(fixture.mount).not.toHaveBeenCalled();
  } finally {
    finish?.({ mountApplication: fixture.mount });
  }
  await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  expect(fixture.mount).toHaveBeenCalledWith(fixture.runtime, expect.objectContaining({ runtime: fixture.runtime }), fixture.home);
});

it("法律页面只加载界面，不创建 Runtime、登录或播放器任务", async () => {
  window.location.hash = "#/privacy";
  vi.doMock("./mountApplication", () => ({ mountApplication: fixture.mount }));
  await import("./entry");
  await waitFor(() => expect(fixture.mount).toHaveBeenCalledOnce());
  expect(fixture.createRuntime).not.toHaveBeenCalled();
  expect(fixture.runtime.bootstrap).not.toHaveBeenCalled();
  expect(fixture.runtime.preparePlayback).not.toHaveBeenCalled();
  expect(fixture.mount).toHaveBeenCalledWith(undefined, undefined, undefined);
  expect(document.title).toBe("TV Privacy Policy");
});

it("UI 模块加载失败时显示既有固定启动错误和重试入口，日志脱敏", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  fixture.createRuntime.mockReturnValue(fixture.runtime);
  vi.doMock("./mountApplication", () => ({ get mountApplication() { throw new Error("UI chunk unavailable token=private-value"); } }));
  const logging = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await import("./entry");
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toHaveTextContent("Unable to start"));
    expect(document.querySelector('[role="alert"]')).toHaveTextContent("We couldn't open this mini app. Please close it and try again.");
    expect(document.querySelector("button")).toHaveTextContent("Retry");
    expect(document.body).not.toHaveTextContent("private-value");
    expect(logging).toHaveBeenCalledWith(expect.objectContaining({ event: "app_module_load_failed", error: "UI chunk unavailable token=[REDACTED]" }));
  } finally { logging.mockRestore(); }
});
