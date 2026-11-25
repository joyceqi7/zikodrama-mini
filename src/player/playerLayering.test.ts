import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function numericZIndex(css: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] || "";
  return Number(rule.match(/z-index:\s*(\d+)/)?.[1] || Number.NaN);
}

const css = readFileSync(resolve(process.cwd(), "src/official-ui.css"), "utf8");
const baseCss = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("官方示例界面与 Player 控件层级", () => {
  it("封面、文案、底部操作和选集面板保持正确层级", () => {
    const poster = numericZIndex(css, ".theater-page .player-transition-poster");
    expect(poster).toBeLessThan(numericZIndex(css, ".theater-copy"));
    expect(poster).toBeLessThan(numericZIndex(css, ".player-bottom-controls"));
    expect(numericZIndex(css, ".theater-page .sheet-mask")).toBeGreaterThan(13);
    expect(css).not.toMatch(/\.theater-page\.is-switching \.player-root\s*\{[^}]*opacity:\s*0/);
  });

  it("官方进度条贴在底部选集组件上沿，且底部操作行位于其下方", () => {
    expect(numericZIndex(css, ".player-bottom-controls")).toBeGreaterThan(numericZIndex(css, ".theater-copy"));
    expect(css).toMatch(/\.player-bottom-controls\s*\{[^}]*bottom:\s*calc\(18px/);
    expect(css).toMatch(/\.theater-page \.player-root \.xgplayer-controls\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.theater-page \.player-root \.xgplayer-controls \.xgplayer-progress\s*\{[^}]*right:\s*0\s*!important;[^}]*bottom:\s*calc\(66px[^}]*left:\s*0\s*!important;[^}]*width:\s*100%\s*!important;[^}]*margin:\s*0\s*!important;[^}]*opacity:\s*0\s*!important;[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.theater-page \.player-stage\.chrome-visible \.player-root \.xgplayer-controls \.xgplayer-progress\s*\{[^}]*opacity:\s*1\s*!important;[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.episode-bar\s*\{[^}]*height:\s*40px;[^}]*border-radius:\s*999px/);
    expect(css).toMatch(/\.playback-rate-button\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*border-radius:\s*50%/);
  });

  it("锁定重试状态隐藏官方进度条，并将广告按钮放在选集栏上方", () => {
    expect(css).toMatch(/\.theater-page\.is-locked-fallback \.player-root \.xgplayer-controls \.xgplayer-progress\s*\{[^}]*display:\s*none\s*!important/);
    expect(css).toMatch(/\.theater-page \.locked-stage\s*\{[^}]*padding:\s*110px 20px calc\(82px \+ var\(--minis-bottom/);
    expect(css).toMatch(/\.theater-page \.locked-stage \.locked-ad-retry\s*\{[^}]*width:\s*100%;[^}]*margin:\s*0/);
  });

  it("播放页只显示一套官方主进度条", () => {
    expect(css).not.toMatch(/\.theater-page \.player-root \.xgplayer-controls\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.theater-page \.player-root \.xgplayer-progress\s*\{[^}]*display:\s*none\s*!important/);
    expect(css).toMatch(/\.theater-page \.player-root \.xgplayer-controls \.xgplayer-progress\s*\{[^}]*display:\s*flex\s*!important/);
    expect(css).toMatch(/\.theater-page \.player-root \.xg-mini-progress,[\s\S]*?display:\s*none\s*!important/);
    expect(css).toMatch(/\.theater-page\.is-media-loading \.player-root \.xgplayer-progress-outer::after\s*\{/);
    expect(css).toMatch(/\.theater-page\.is-media-loading \.player-root \.xgplayer-progress-played\s*\{[^}]*opacity:\s*0\s*!important/);
  });

  it("播放控件只在 chrome-visible 时显示，抽屉打开时让位", () => {
    const style = document.createElement("style");
    style.textContent = `${baseCss}\n${css}`;
    const page = document.createElement("main");
    page.className = "theater-page";
    const stage = document.createElement("div");
    stage.className = "player-stage";
    const top = document.createElement("div");
    top.className = "player-topbar player-chrome";
    const bottom = document.createElement("div");
    bottom.className = "player-bottom-controls player-chrome";
    const playerRoot = document.createElement("div");
    playerRoot.className = "player-root";
    const progress = document.createElement("div");
    progress.className = "xgplayer-progress";
    const miniProgress = document.createElement("div");
    miniProgress.className = "xg-mini-progress";
    const detachedProgress = document.createElement("div");
    detachedProgress.className = "xgplayer-progress";
    const controls = document.createElement("div");
    controls.className = "xgplayer-controls";
    controls.append(progress);
    playerRoot.append(controls, miniProgress, detachedProgress);
    stage.append(playerRoot, top, bottom);
    page.append(stage);
    document.head.append(style);
    document.body.append(page);
    try {
      expect(getComputedStyle(top).opacity).toBe("0");
      expect(getComputedStyle(bottom).opacity).toBe("0");
      expect(getComputedStyle(progress).opacity).toBe("0");
      expect(getComputedStyle(progress).pointerEvents).toBe("none");
      expect(getComputedStyle(miniProgress).display).toBe("none");
      expect(getComputedStyle(detachedProgress).display).toBe("none");
      stage.classList.add("chrome-visible");
      expect(getComputedStyle(top).opacity).toBe("1");
      expect(getComputedStyle(bottom).opacity).toBe("1");
      expect(getComputedStyle(progress).opacity).toBe("1");
      expect(getComputedStyle(progress).pointerEvents).toBe("auto");
      expect(getComputedStyle(progress).display).toBe("flex");
      expect(getComputedStyle(detachedProgress).display).toBe("none");
      expect(getComputedStyle(controls).opacity).toBe("1");
      expect(getComputedStyle(controls).visibility).toBe("visible");
      stage.classList.remove("chrome-visible");
      progress.classList.add("active");
      expect(getComputedStyle(progress).opacity).toBe("0");
      expect(getComputedStyle(bottom).opacity).toBe("0");
      expect(getComputedStyle(controls).opacity).toBe("0");
      stage.classList.add("chrome-visible");
      page.classList.add("is-episode-drawer-open");
      expect(getComputedStyle(top).opacity).toBe("0");
      expect(getComputedStyle(bottom).opacity).toBe("0");
      expect(getComputedStyle(progress).opacity).toBe("0");
      expect(getComputedStyle(progress).pointerEvents).toBe("none");
      expect(getComputedStyle(miniProgress).display).toBe("none");
    } finally { page.remove(); style.remove(); }
  });
});
