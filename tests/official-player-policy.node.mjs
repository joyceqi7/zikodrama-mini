import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

async function productionSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionSources(target));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(target);
    }
  }
  return files;
}

test("官方应用由宿主提供 Player，直连入口没有原生播放器回退", async () => {
  const packageJSON = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJSON.dependencies?.["@volcengine/veplayer"], undefined);

  const files = await productionSources(path.join(projectRoot, "src"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(projectRoot, file);
    assert.doesNotMatch(source, /from\s+["']@volcengine\/veplayer["']/, relative);
    assert.doesNotMatch(source, /<video(?:\s|>)/i, relative);
    assert.doesNotMatch(source, /createElement\(\s*["']video["']\s*\)/, relative);
    assert.doesNotMatch(source, /refreshDirectUrl|privateDrm\s*:|playList\s*:/, relative);
  }

  // 官方通道及实例缓存由适配器行为测试验证；这里只约束生产代码不得引入替代播放器。
});

test("HTML 只预连接配置环境，公开预取按入口路由执行", async () => {
  const html = await readFile(path.join(projectRoot, "index.html"), "utf8");
  const main = await readFile(path.join(projectRoot, "src/main.tsx"), "utf8");
  const sdk = html.indexOf('script data-tiktok-sdk="true"');
  assert.ok(sdk > 0);
  assert.ok(html.indexOf('rel="preconnect" href="%VITE_API_BASE_URL%"') < sdk);
  assert.doesNotMatch(html, /rel="preload" as="fetch"/);
  assert.doesNotMatch(html, /img\.tkdrama\.site/);
  assert.match(main, /if \(homeEntry\) void runtime\?\.prefetchHome/);
});

test("基础版独立 SDK 仅在直连适配器加载，不启用高级媒体预加载或强制转码输出", async () => {
  const packageJSON = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJSON.dependencies["@byteplus/veplayer"], "1.19.1");
  const files = await productionSources(path.join(projectRoot, "src"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes('import("@byteplus/veplayer')) assert.equal(path.relative(projectRoot, file), "src/player/vePlayerEngine.ts");
  }
  // VID 播放信息预取属于基础能力；两份直连模块都不能调用高级字节预加载。
  for (const name of ["vePlayerEngine.ts", "directMediaInfoPrefetch.ts"]) {
    const source = await readFile(path.join(projectRoot, "src/player", name), "utf8");
    assert.doesNotMatch(source, /\b(?:setPreloadList|setPreloadScene)\b|(?:\.prepare|TTMinis\.getPlayer)\s*\(|Definition\s*:|Format\s*:|enableMp4MSE\s*:\s*true/, name);
  }
});
