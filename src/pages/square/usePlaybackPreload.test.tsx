import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePlaybackPreload } from "./usePlaybackPreload";
import type { Runtime } from "../../runtime/runtime";
import type { PlayResolveResult } from "../../domain/types";

let intersect: IntersectionObserverCallback;
const observed: Element[] = [];
function installObserver() {
  observed.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe(element: Element) { observed.push(element); }
    unobserve() {}
    disconnect() {}
  });
}
function show(ids: string[]) {
  act(() => intersect(observed.map(target => ({ target, isIntersecting: ids.includes(target.id), intersectionRatio: ids.includes(target.id) ? 1 : 0 })) as IntersectionObserverEntry[], {} as IntersectionObserver));
}
function Fixture({ runtime, enabled = true, covers = false }: { runtime: Runtime; enabled?: boolean; covers?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  usePlaybackPreload(root, runtime, enabled, "app:user");
  return <div ref={root}>{["hero", "hot", "catalog", "pressed"].map(id => <button key={id} id={id} data-preload-drama={id} data-preload-episode="first">{covers && <img src={`/${id}.webp`} alt="" />}{id}</button>)}</div>;
}
const playable = (id: string) => ({ status: "playable", playback: { channel: "byteplus", vid: id, albumId: id, episodeId: "first" } }) as PlayResolveResult;
const locked = (id: string) => ({ status: "access_required", preload: { channel: "byteplus", vid: id, albumId: id, episodeId: "first" } }) as PlayResolveResult;
afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ""; });

it("首页提前准备锁定集媒资，仍只提交官方预加载任务", async () => {
  installObserver();
  const runtime = { resolvePlayback: vi.fn(async (id: string) => locked(id)), preloadMedia: vi.fn(async () => {}) } as unknown as Runtime;
  render(<Fixture runtime={runtime} />);
  show(["hero"]);
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([expect.objectContaining({ vid: "hero" })], 0));
});

it("可见推荐独立预取，慢候选和失败候选不阻断已就绪视频", async () => {
  installObserver();
  let finish!: (result: PlayResolveResult) => void;
  const resolvePlayback = vi.fn((id: string) => id === "hero" ? Promise.resolve(playable(id)) : id === "hot" ? new Promise<PlayResolveResult>(resolve => { finish = resolve; }) : Promise.reject(new Error("unavailable")));
  const runtime = { resolvePlayback, preloadMedia: vi.fn(async () => {}), clearMediaPreload: vi.fn() } as unknown as Runtime;
  render(<Fixture runtime={runtime} />);
  show(["hero", "hot", "catalog"]);
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([expect.objectContaining({ vid: "hero" })], 0));
  expect(resolvePlayback).not.toHaveBeenCalledWith("pressed", "first");
  show(["hot", "catalog"]);
  await act(async () => finish(playable("hot")));
  expect(runtime.preloadMedia).toHaveBeenLastCalledWith([expect.objectContaining({ vid: "hot" })], 0);
});

it("按下目标提升到队首，离页后的迟到授权不能覆盖媒体列表", async () => {
  installObserver();
  let finish!: (result: PlayResolveResult) => void;
  const runtime = { resolvePlayback: vi.fn((id: string) => id === "catalog" ? new Promise<PlayResolveResult>(resolve => { finish = resolve; }) : Promise.resolve(playable(id))), preloadMedia: vi.fn(async () => {}), clearMediaPreload: vi.fn() } as unknown as Runtime;
  const view = render(<Fixture runtime={runtime} />);
  show(["hero", "hot", "catalog"]);
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalled());
  fireEvent.pointerDown(view.getByText("pressed"));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenLastCalledWith([expect.objectContaining({vid:"pressed"})], 0));
  show(["catalog"]);
  const calls = vi.mocked(runtime.preloadMedia!).mock.calls.length;
  window.location.hash = "#/watch/pressed/first";
  view.unmount();
  await act(async () => finish(playable("catalog")));
  expect(runtime.preloadMedia).toHaveBeenCalledTimes(calls);
  expect(runtime.clearMediaPreload).not.toHaveBeenCalled();
});

it("身份尚未就绪时可见和按下均不发授权请求", async () => {
  installObserver();
  const runtime = { resolvePlayback: vi.fn(), preloadMedia: vi.fn(), clearMediaPreload: vi.fn() } as unknown as Runtime;
  const view = render(<Fixture runtime={runtime} enabled={false} />);
  fireEvent.pointerDown(view.getByText("hero"));
  expect(runtime.resolvePlayback).not.toHaveBeenCalled();
  expect(observed).toHaveLength(0);
});


it("慢封面不阻塞主候选，明确点击只预热目标", async () => {
  installObserver();
  const runtime = { resolvePlayback: vi.fn(async (id: string) => playable(id)), preloadMedia: vi.fn(async () => {}), clearMediaPreload: vi.fn() } as unknown as Runtime;
  const view = render(<Fixture runtime={runtime} covers />);
  show(["hero", "hot"]);
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenCalledWith([expect.objectContaining({ vid: "hero" })], 0));
  fireEvent.pointerDown(view.getByText("pressed"));
  await waitFor(() => expect(runtime.preloadMedia).toHaveBeenLastCalledWith([expect.objectContaining({ vid: "pressed" })], 0));
});

it("封面命中缓存时直接预取，卸载后的图片事件不再触发预取", async () => {
  installObserver();
  const runtime = { resolvePlayback: vi.fn(async (id: string) => playable(id)), preloadMedia: vi.fn(async () => {}), clearMediaPreload: vi.fn() } as unknown as Runtime;
  const view = render(<Fixture runtime={runtime} covers />);
  const hero = view.container.querySelector("#hero img")!;
  Object.defineProperty(hero, "complete", { value: true });
  show(["hero"]);
  await waitFor(() => expect(runtime.resolvePlayback).toHaveBeenCalledTimes(1));
  fireEvent.load(hero);
  view.unmount();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(runtime.resolvePlayback).toHaveBeenCalledTimes(1);
});

// 首页续播预取必须与最终进入的分集一致，不能仍然消耗带宽准备首集。
it("续播卡片优先预取最近观看集", async () => {
  installObserver();
  const runtime = {
    localLibrary: { history: () => [{ dramaId: "hero", episodeId: "episode-4", updatedAt: "2026-09-17T00:00:00Z" }] },
    resolvePlayback: vi.fn(async () => playable("hero")), preloadMedia: vi.fn(async () => {}),
  } as unknown as Runtime;
  const view = render(<Fixture runtime={runtime} />);
  view.getByText("hero").setAttribute("data-preload-resume", "true");
  fireEvent.pointerDown(view.getByText("hero"));
  await waitFor(() => expect(runtime.resolvePlayback).toHaveBeenCalledWith("hero", "episode-4"));
  expect(runtime.resolvePlayback).not.toHaveBeenCalledWith("hero", "first");
});
