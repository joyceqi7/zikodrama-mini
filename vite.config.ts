import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 构建修订只用于诊断；源码压缩包没有 Git 时仍能构建，不影响真实 SDK 接入。
let miniBuildID = "unknown";
try { miniBuildID = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* 无 Git 的构建环境使用 unknown。 */ }

// 单个应用可以覆盖版本，默认业务版本由共享配置统一维护。
const miniVersion = process.env.VITE_MINI_APP_VERSION ?? JSON.parse(readFileSync(new URL('./configs/mini-version.json', import.meta.url), 'utf8')).appVersion;
if (typeof miniVersion !== 'string' || miniVersion.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(miniVersion)) throw new Error('Mini appVersion must be a three-part version such as 1.0.1');

export default defineConfig({
  plugins: [react(), {
    name: 'mini-build-metadata',
    transformIndexHtml(_html, { bundle }) {
      if (!bundle) return;
      const main = Object.values(bundle).find(chunk =>
        chunk.type === "chunk" && chunk.moduleIds.some(id => id.endsWith("/src/main.tsx")));
      if (!main || main.type !== "chunk") throw new Error("业务启动模块未生成，无法在 HTML 中登记预加载");
      // HTML 同时发现业务 JS 与 CSS，轻入口可先发配置而不为业务代码额外增加一轮下载等待。
      return [
        { tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `/${main.fileName}` }, injectTo: "head" },
        ...Array.from(main.viteMetadata?.importedCss ?? [], fileName => ({
          tag: "link", attrs: { rel: "preload", as: "style", crossorigin: true, href: `/${fileName}` }, injectTo: "head" as const,
        })),
      ];
    },
    generateBundle(_options, bundle) {
      this.emitFile({type:'asset',fileName:'mini-build.json',source:JSON.stringify({appVersion:miniVersion,buildId:miniBuildID,builtAt:new Date().toISOString()},null,2)});
      // 广告入口首包只追踪静态依赖；首页及 Swiper 必须留在动态路由中，构建时防止重新混入。
      const visited = new Set<string>();
      const checkEntry = (fileName: string) => {
        if (visited.has(fileName)) return;
        visited.add(fileName);
        const chunk = bundle[fileName];
        if (chunk?.type !== 'chunk') return;
        if (Object.keys(chunk.modules).some(id => /\/(?:src\/pages\/square|node_modules\/swiper|node_modules\/@byteplus\/veplayer)\//.test(id))) {
          this.error('首包的静态依赖中不能包含首页、Swiper 或独立播放器，请通过动态入口加载。');
        }
        chunk.imports.forEach(checkEntry);
      };
      Object.values(bundle).filter(chunk => chunk.type === 'chunk' && chunk.isEntry).forEach(chunk => checkEntry(chunk.fileName));
    },
  }],
  define: { __MINI_BUILD_ID__: JSON.stringify(miniBuildID), __MINI_APP_VERSION__:JSON.stringify(miniVersion) },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // 本地开发使用同源 API 代理，登录、广告与播放器通过官方 SDK 桥接。
    proxy: {
      "/api": "http://101.47.11.18:18080",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});
