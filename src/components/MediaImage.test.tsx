import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoverState } from "./coverLoader";

let state: CoverState = { status: "queued" };
let listener: (() => void) | undefined;
const request = vi.hoisted(() => vi.fn());

vi.mock("./coverLoader", () => ({
  coverLoader: {
    request: (...args: unknown[]) => {
      request(...args);
      return {
        snapshot: () => state,
        settle: vi.fn(),
        subscribe: (next: () => void) => { listener = next; return () => { listener = undefined; }; },
      };
    },
  },
}));

import { MediaImage } from "./MediaImage";

afterEach(() => {
  state = { status: "queued" };
  listener = undefined;
  request.mockClear();
  vi.unstubAllGlobals();
});

describe("MediaImage", () => {
  it("仅在图片等待和加载期间保留加载动画 class", () => {
    const view = render(<MediaImage src="https://images.example/cover.jpg" />);
    expect(view.container.querySelector("img")).toHaveClass("media-image-loading");

    act(() => {
      state = { status: "ready", src: "https://images.example/cover.jpg" };
      listener?.();
    });

    expect(view.container.querySelector("img")).not.toHaveClass("media-image-loading");
  });
  it("屏外图片接近可视区后才进入下载队列", () => {
    let intersect!: IntersectionObserverCallback;
    const observed: Element[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    });
    const view = render(<MediaImage src="https://images.example/lazy.jpg" loading="lazy" />);
    expect(observed).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    expect(view.container.querySelector("img")).toHaveAttribute("loading", "lazy");
    act(() => intersect([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(request).toHaveBeenCalledOnce();
  });
});
