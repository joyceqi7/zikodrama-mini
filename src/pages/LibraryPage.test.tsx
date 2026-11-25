import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LibraryPage } from "./LibraryPage";
import { LocalLibraryStore } from "../domain/localLibrary";
import { createMemoryStorage } from "../domain/browserStorage";
import type { DramaSummary } from "../domain/types";
import { RuntimeContext } from "../runtime/RuntimeContext";
import type { Runtime } from "../runtime/runtime";

const summary: DramaSummary = { id: "9007199254740993", firstEpisodeId: "501", title: "Local history", description: "", coverUrl: "", tags: [], episodeCount: 3, status: "completed" };
function show(library: LocalLibraryStore) {
  const request = vi.fn(() => { throw new Error("历史页不应请求网络"); });
  const runtime = { localLibrary: library, getApplicationBrand: () => ({ name: "Test", logoUrl: "" }), api: { home: request, drama: request }, loadPublicCatalog: request } as unknown as Runtime;
  const view = render(<RuntimeContext.Provider value={runtime}><MemoryRouter><LibraryPage /></MemoryRouter></RuntimeContext.Provider>);
  return { view, request };
}

it("重新创建 Store 后同步显示本机摘要和最近一集，不请求网络", () => {
  const storage = createMemoryStorage();
  let time = Date.now();
  const library = new LocalLibraryStore("app", "A", storage, () => new Date(time++));
  for (const n of [1, 2]) library.recordProgress({ dramaId: summary.id, episodeId: String(500 + n), episodeNumber: n, progressSeconds: 12, durationSeconds: 60, drama: summary });
  const { request } = show(new LocalLibraryStore("app", "A", storage));
  expect(screen.getByText(summary.title)).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByRole("link", { name: /Local history/ })).toHaveAttribute("href", `/watch/${summary.id}/502`);
  expect(screen.queryByRole("status")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("旧历史缺少摘要仍保留续播入口，不显示无历史或发起补全请求", () => {
  const library = new LocalLibraryStore("app", "A", createMemoryStorage());
  library.recordProgress({ dramaId: summary.id, episodeId: "501", episodeNumber: 1, progressSeconds: 12, durationSeconds: 60 });
  const { request } = show(library);
  expect(screen.getByRole("link", { name: /Previously watched drama/ })).toHaveAttribute("href", `/watch/${summary.id}/501`);
  expect(screen.queryByText("No watch history")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("不同账号不展示旧历史，无记录直接显示空状态", () => {
  const storage = createMemoryStorage();
  new LocalLibraryStore("app", "A", storage).recordProgress({ dramaId: summary.id, episodeId: "501", episodeNumber: 1, progressSeconds: 12, durationSeconds: 60, drama: summary });
  const { request } = show(new LocalLibraryStore("app", "B", storage));
  expect(screen.getByText("No watch history")).toBeInTheDocument();
  expect(screen.queryByText(summary.title)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("历史首屏复用首页缩略图并优先加载，坏图回退原图后显示占位", () => {
  const storage = createMemoryStorage();
  const library = new LocalLibraryStore("app", "A", storage);
  const coverUrl = "https://images.example/drama~tplv-vod-noop.image";
  for (let number = 1; number <= 4; number += 1) {
    library.recordProgress({
      dramaId: String(number), episodeId: `episode-${number}`, episodeNumber: number,
      progressSeconds: 12, durationSeconds: 60,
      drama: { ...summary, id: String(number), coverUrl },
    });
  }
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const { view, request } = show(library);
    const images = view.container.querySelectorAll<HTMLImageElement>(".history-poster img");
    expect(images).toHaveLength(4);
    expect(images[0]).toHaveAttribute("src", "https://images.example/drama~tplv-vod-rs:480:0.webp");
    expect(images[0]).toHaveAttribute("loading", "eager");
    expect(images[0]).toHaveAttribute("fetchpriority", "high");
    expect(images[3]).toHaveAttribute("loading", "lazy");
    fireEvent.error(images[0]);
    expect(images[0]).toHaveAttribute("src", coverUrl);
    expect(warning).not.toHaveBeenCalled();
    fireEvent.error(images[0]);
    expect(view.container.querySelectorAll(".history-poster-icon")).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "history_cover_load_failed", error: "Thumbnail and original cover image failed to load" }));
    expect(request).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
