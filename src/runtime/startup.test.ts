import { afterEach, expect, it, vi } from "vitest";

import type { Runtime } from "./runtime";
import { startApplication } from "./startup";
import * as theaterModule from "./theaterModule";

afterEach(() => vi.restoreAllMocks());

it("业务脚本同步启动身份、剧场代码和当前通道准备，不等待 React 或业务身份完成", async () => {
  const calls: string[] = [];
  const bootstrap = new Promise<void>(() => undefined);
  const playback = new Promise<void>(() => undefined);
  const runtime = {
    bootstrap: vi.fn(() => { calls.push("bootstrap"); return bootstrap; }),
    preparePlayback: vi.fn(() => { calls.push("playback"); return playback; }),
  } as unknown as Runtime;
  vi.spyOn(theaterModule, "preloadTheaterModule").mockImplementation(() => { calls.push("theater"); });
  const startup = startApplication(runtime, true);
  expect(calls).toEqual(["bootstrap", "theater", "playback"]);
  expect(startup.runtime).toBe(runtime);
  expect(startup.bootstrap).toBe(bootstrap);
  expect(startup.playback).toBe(playback);
});

it("自然首页只提前登录，播放器和剧场代码留给现有延迟或明确观看意图", async () => {
  const runtime = { bootstrap: vi.fn(async () => undefined), preparePlayback: vi.fn(async () => undefined) } as unknown as Runtime;
  const theater = vi.spyOn(theaterModule, "preloadTheaterModule").mockImplementation(() => undefined);
  const startup = startApplication(runtime, false);
  await startup.bootstrap;
  expect(startup.playback).toBeUndefined();
  expect(runtime.preparePlayback).not.toHaveBeenCalled();
  expect(theater).not.toHaveBeenCalled();
});

it("React 下载期间立即接住启动与播放器拒绝，保留失败 Promise 并只记录脱敏诊断", async () => {
  const runtime = {
    bootstrap: vi.fn(async () => { throw new Error("login failed token=private-login"); }),
    preparePlayback: vi.fn(async () => { throw new Error("SDK failed token=private-sdk"); }),
  } as unknown as Runtime;
  vi.spyOn(theaterModule, "preloadTheaterModule").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const startup = startApplication(runtime, true);
  // 模拟 UI 块仍在下载；原任务的拒绝不能成为未处理异常，也不能被转换成成功。
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(startup.bootstrap).rejects.toThrow("login failed");
  await expect(startup.playback).rejects.toThrow("SDK failed");
  expect(error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "app_initialize_failed", error: "login failed token=[REDACTED]" }));
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "player_prepare_failed", error: "SDK failed token=[REDACTED]" }));
});
