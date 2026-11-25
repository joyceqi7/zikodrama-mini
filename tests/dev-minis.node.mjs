import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { prepareMinisDev } from "../scripts/dev-minis.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = await readFile(join(projectRoot, "index.html"), "utf8");
const key = "minis-local-test-key";
const appId = "0009007199254740993123";

async function fixture(t) {
  const saved = {};
  for (const name of ["VITE_TIKTOK_APP_ID", "VITE_TIKTOK_CLIENT_KEY"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const root = await mkdtemp(join(tmpdir(), "drama minis test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "configs", "apps"), { recursive: true });
  await writeFile(join(root, "configs", "apps", `${appId}.json`), JSON.stringify({
    tiktokAppId: appId,
    name: "Test Drama",
    logoUrl: "https://cdn.test/logo.png",
    clientKey: key,
    deployments: { sandbox: { apiBaseUrl: "https://api.sandbox.test" } },
  }));
  await writeFile(join(root, "index.html"), template);
  await writeFile(join(root, "minis.config.json"), JSON.stringify({
    dev: { host: "localhost", port: 5173 },
    build: { outputDir: "dist", htmlEntry: "index.html" },
    navbar: { style: "custom" },
    domain: { trustedDomains: ["https://cdn.test"] },
  }));
  return root;
}

test("联调按 Vite 本地覆盖配置生成入口，并保留长 AppID、源码和打包配置", async (t) => {
  const root = await fixture(t);
  const sourceConfig = await readFile(join(root, "minis.config.json"), "utf8");
  const prepared = await prepareMinisDev(root, appId);
  t.after(() => rm(prepared.directory, { recursive: true, force: true }));
  const html = await readFile(join(prepared.directory, "index.html"), "utf8");
  assert.match(html, /TTMinis\.init\(\{ clientKey: "minis-local-test-key" \}\)/);
  assert.doesNotMatch(html, /%VITE_TIKTOK_CLIENT_KEY%|not-for-html/);
  assert.equal(prepared.identity.VITE_TIKTOK_APP_ID, appId);
  const preparedConfig = JSON.parse(await readFile(join(prepared.directory, "minis.config.json"), "utf8"));
  assert.deepEqual(preparedConfig.domain.trustedDomains, ["https://api.sandbox.test", "https://cdn.test"]);
  assert.equal(await readFile(join(root, "index.html"), "utf8"), template);
  assert.equal(await readFile(join(root, "minis.config.json"), "utf8"), sourceConfig);
});

test("已有端口被占用时另选端口，并同步到 CLI 配置与 Vite 启动参数", async (t) => {
  const root = await fixture(t);
  const occupied = createServer();
  occupied.listen(0);
  await once(occupied, "listening");
  t.after(() => new Promise((resolveClose) => occupied.close(resolveClose)));
  const port = occupied.address().port;
  const config = JSON.parse(await readFile(join(root, "minis.config.json"), "utf8"));
  config.dev.port = port;
  await writeFile(join(root, "minis.config.json"), JSON.stringify(config));
  const prepared = await prepareMinisDev(root, appId);
  t.after(() => rm(prepared.directory, { recursive: true, force: true }));
  assert.notEqual(prepared.port, port);
  assert.equal(prepared.requestedPort, port);
  const cliConfig = JSON.parse(await readFile(join(prepared.directory, "minis.config.json"), "utf8"));
  assert.equal(cliConfig.dev.port, prepared.port);
  assert.ok((await readFile(join(prepared.directory, "start-vite.mjs"), "utf8")).includes(`'--port', "${prepared.port}"`));
  assert.equal(occupied.listening, true);
});

test("应用配置占位符和与当前配置不一致的硬编码 Key 在启动前被拒绝", async (t) => {
  const root = await fixture(t);
  for (const value of ["", "replace_with_tiktok_client_key", "invalid<script>"]) {
    await writeFile(join(root, "configs", "apps", `${appId}.json`), JSON.stringify({
      tiktokAppId: appId, name: "Test Drama", logoUrl: "https://cdn.test/logo.png", clientKey: value,
      deployments: { sandbox: { apiBaseUrl: "https://api.sandbox.test" } },
    }));
    await assert.rejects(prepareMinisDev(root, appId), /clientKey/i);
  }
  await writeFile(join(root, "configs", "apps", `${appId}.json`), JSON.stringify({
    tiktokAppId: appId, name: "Test Drama", logoUrl: "https://cdn.test/logo.png", clientKey: key,
    deployments: { sandbox: { apiBaseUrl: "https://api.sandbox.test" } },
  }));
  await writeFile(join(root, "index.html"), template.replaceAll("%VITE_TIKTOK_CLIENT_KEY%", "another-app-key"));
  await assert.rejects(prepareMinisDev(root, appId), /Source TTMinis.init clientKey/);
});

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitUntil(check, describe, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`等待超时：${describe}`);
}

async function reachable(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(500) });
  } catch {
    // 轮询等待服务启动或确认其已关闭，连接拒绝属于测试预期。
    return undefined;
  }
}

async function startFixture(t, root) {
  // 只隔离 CLI 用户配置目录和浏览器打开动作；CLI、校验器、Vite 与 HTTP 均使用真实实现。
  const homeDirectory = join(root, "cli-user");
  await mkdir(homeDirectory);
  const preload = join(root, "cli-user.cjs");
  await writeFile(preload, `require('node:os').homedir = () => ${JSON.stringify(homeDirectory)};`);
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("VITE_") || name.startsWith("TTMS_PLAYGROUND_")) delete environment[name];
  }
  const child = spawn(process.execPath, [join(projectRoot, "scripts/dev-minis.mjs"), "--app", appId], {
    cwd: root,
    env: { ...environment, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, CHROME_PATH: "/usr/bin/false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  });
  return { child, closed, output: () => output };
}

test("真实 Minis CLI 通过校验、自动启动原项目 Vite，并在中断后释放服务与临时目录", { timeout: 50000 }, async (t) => {
  const root = await fixture(t);
  const port = await availablePort();
  await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(join(root, "vite.config.mjs"), `export default {server:{host:'127.0.0.1',port:${port},strictPort:true},optimizeDeps:{noDiscovery:true}};`);
  const config = JSON.parse(await readFile(join(root, "minis.config.json"), "utf8"));
  config.dev = { host: "127.0.0.1", port };
  await writeFile(join(root, "minis.config.json"), JSON.stringify(config));
  // 本用例只验证启动链路，页面不引入业务模块，也不执行 SDK 网络调用。
  await writeFile(join(root, "index.html"), template.replace('<script type="module" src="/src/entry.ts"></script>', ""));
  const sourceBefore = await readFile(join(root, "index.html"), "utf8");
  const running = await startFixture(t, root);
  const ansi = /\u001b\[[0-9;]*m/g;
  let debugUrl;
  try {
    debugUrl = await waitUntil(() => {
      assert.equal(running.child.exitCode, null, running.output());
      const output = running.output().replace(ansi, "");
      const guide = output.indexOf("────────────────");
      return guide < 0 ? undefined : output.slice(guide).match(/http:\/\/localhost:\d+/)?.[0];
    }, "官方调试页启动", 35000); // 官方 CLI 最多等待业务服务 30 秒，测试还需覆盖其前置启动时间。
  } catch (error) {
    throw new Error(`${error.message}\n${running.output()}`);
  }
  const info = await (await fetch(`${debugUrl}/api/env`)).json();
  assert.equal(info.clientKey, key);
  assert.equal(info.minisUrl, `http://127.0.0.1:${port}`);
  assert.equal((await fetch(debugUrl)).status, 200);
  const served = await (await fetch(info.minisUrl)).text();
  assert.match(served, /TTMinis\.init\(\{ clientKey: "minis-local-test-key" \}\)/);
  assert.doesNotMatch(served, /%VITE_TIKTOK_CLIENT_KEY%|not-for-html/);
  assert.equal(await readFile(join(root, "index.html"), "utf8"), sourceBefore);
  assert.deepEqual(JSON.parse(await readFile(join(root, "minis.config.json"), "utf8")), config);
  assert.doesNotMatch(running.output(), /minis_dev_failed|clientKey.*does not match/);
  running.child.kill("SIGTERM");
  assert.equal((await running.closed)[0], 130);
  await waitUntil(async () => !(await reachable(info.minisUrl)), "Vite 端口释放");
  await waitUntil(async () => !(await reachable(debugUrl)), "CLI 端口释放");
  const tempDirectory = running.output().replace(ansi, "").match(/(?:Project|项目目录):\s+([^\n]*drama-mini-dev-[^\n]+)/)?.[1]?.trim();
  assert.ok(tempDirectory, running.output());
  await assert.rejects(readFile(join(tempDirectory, "index.html")), { code: "ENOENT" });
});

test("启动配置失败返回非零状态并记录明确原因，不输出输入中的敏感值", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "configs", "apps", `${appId}.json`), JSON.stringify({
    tiktokAppId: appId, name: "Test Drama", logoUrl: "https://cdn.test/logo.png", clientKey: "invalid<script>",
    deployments: { sandbox: { apiBaseUrl: "https://api.sandbox.test" } },
  }));
  const running = await startFixture(t, root);
  assert.equal((await running.closed)[0], 1);
  const event = JSON.parse(running.output().trim().split("\n").at(-1));
  assert.equal(event.level, "error");
  assert.equal(event.event, "minis_dev_failed");
  assert.match(event.error, /clientKey/i);
  assert.doesNotMatch(running.output(), /invalid<script>/);
});
