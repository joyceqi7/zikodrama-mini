import { describe, expect, it, vi } from "vitest";

import type { TikTokMinisSDK, TikTokShareListener } from "./types";
import { registerTikTokShare, shareWithTikTok } from "./share";

const payload = {
  title: "The Last Alibi · Episode 2",
  desc: "Watch the next twist",
  imageUrl: "https://images.example.test/poster.jpg",
  query: { dramaId: "7637420375425239060", episodeId: "7637437361307027477" },
};

describe("TikTok share adapter", () => {
  it("answers the native minis.share event with string deep-link identifiers", async () => {
    let listener: TikTokShareListener | undefined;
    const share = vi.fn((callback: (result: { is_success: boolean }) => void) => callback({ is_success: true }));
    const sdk = {
      on: vi.fn((_event: "minis.share", next: TikTokShareListener) => { listener = next; return "share-id"; }),
      off: vi.fn(),
      share,
    } as unknown as TikTokMinisSDK;
    const onOutcome = vi.fn();

    const unregister = registerTikTokShare(sdk, payload, onOutcome);
    listener?.();
    await vi.waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ status: "success" }));
    expect(share).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      query: { dramaId: "7637420375425239060", episodeId: "7637437361307027477" },
    }));
    unregister();
    expect(sdk.off).toHaveBeenCalledWith("minis.share", "share-id");
  });

  it("缺少官方 SDK 时返回不可用，不调用浏览器分享或剪贴板", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText }, share: vi.fn() });
    await expect(shareWithTikTok(undefined, payload)).resolves.toEqual({ status: "unsupported" });
    expect(writeText).not.toHaveBeenCalled();
    expect(navigator.share).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
