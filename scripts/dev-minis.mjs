import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { argumentValue, selectApplication } from "./app-selector.mjs";
import { buildMinisConfig, loadApplicationProfile, profileEnvironment } from "./package-minis.mjs";

async function availableDevPort(preferred) {
  const port = Number(preferred);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("minis.config.json dev.port must be a valid TCP port");
  }
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", (error) => {
      // 已有服务可能属于另一应用，不交给 CLI 自动复用；为本次环境另选空闲端口。
      if (error.code === "EADDRINUSE" && port !== 0) {
        availableDevPort(0).then(resolvePort, reject);
      } else reject(error);
    });
    server.listen(port, () => {
      const selected = server.address().port;
      server.close((error) => error ? reject(error) : resolvePort(selected));
    });
  });
}

/** prepareMinisDev 在临时目录生成 CLI 校验入口；真实 Vite 仍从原项目读取源码、配置和依赖。 */
export async function prepareMinisDev(root, tiktokAppId) {
  await selectApplication({ root, appId: tiktokAppId, action: "预览", interactive: false });
  const identity = profileEnvironment(
    await loadApplicationProfile(root, tiktokAppId),
    "sandbox",
  );
  const config = buildMinisConfig(JSON.parse(await readFile(join(root, "minis.config.json"), "utf8")), {
    apiBaseURL: identity.VITE_API_BASE_URL,
  });
  const source = await readFile(resolve(root, config.build.htmlEntry), "utf8");
  const clientKey = identity.VITE_TIKTOK_CLIENT_KEY;
  // CLI 0.0.7 在启动 Vite 前直接读取 HTML，不能把未展开的模板交给它校验。
  const html = source.replaceAll("%VITE_TIKTOK_CLIENT_KEY%", clientKey);
  const actualKey = html.match(/TTMinis\.init\(\s*\{[\s\S]*?clientKey\s*:\s*(['"`])([\s\S]*?)\1/)?.[2];
  if (actualKey !== clientKey) {
    throw new Error("Source TTMinis.init clientKey must use %VITE_TIKTOK_CLIENT_KEY% or match the development configuration");
  }
  const port = await availableDevPort(config.dev.port);
  const directory = await mkdtemp(join(tmpdir(), "drama-mini-dev-"));
  try {
    await writeFile(join(directory, "index.html"), html);
    await writeFile(join(directory, "minis.config.json"), JSON.stringify({
      ...config,
      dev: { ...config.dev, port },
      build: { ...config.build, htmlEntry: "index.html" },
    }, null, 2));
    await writeFile(join(directory, "package.json"), JSON.stringify({
      private: true,
      scripts: { dev: "node start-vite.mjs" },
    }, null, 2));
    // 路径写入 JavaScript 字符串而非 shell 命令，兼容含空格等字符的工作区路径。
    const viteEntry = join(root, "node_modules/vite/bin/vite.js");
    await writeFile(join(directory, "start-vite.mjs"), [
      `process.chdir(${JSON.stringify(root)});`,
      `process.argv = [process.execPath, ${JSON.stringify(viteEntry)}, '--port', ${JSON.stringify(String(port))}, '--strictPort'];`,
      `await import(${JSON.stringify(pathToFileURL(viteEntry).href)});`,
    ].join("\n"));
    return { directory, identity, port, requestedPort: Number(config.dev.port) };
  } catch (error) {
    await removeDevDirectory(directory);
    throw error;
  }
}

async function removeDevDirectory(directory) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "minis_dev_cleanup_failed", error: error.message }));
    throw error;
  }
}

function signalCli(child, signal) {
  if (!child?.pid) return;
  try {
    // CLI 启动的 npm/Vite 属于独立进程组，退出时一并结束，避免占住下次调试端口。
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error(JSON.stringify({ level: "error", event: "minis_dev_stop_failed", error: error.message }));
    }
  }
}

/** runMinisDev 启动项目固定版本的官方 CLI，透传退出结果，并清理本次创建的进程与临时文件。 */
export async function runMinisDev(root = process.cwd(), tiktokAppId = "") {
  const application = await selectApplication({ root, appId: tiktokAppId, action: "预览" });
  console.info(`已选择：${application.name} (${application.tiktokAppId})`);
  const prepared = await prepareMinisDev(resolve(root), application.tiktokAppId);
  if (prepared.port !== prepared.requestedPort) {
    console.info(JSON.stringify({ level: "info", event: "minis_dev_port_changed", port: prepared.port, message: "Configured port is occupied; starting a separate development server" }));
  }
  let child;
  let stopTimer;
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    signalCli(child, "SIGTERM");
    stopTimer = setTimeout(() => signalCli(child, "SIGKILL"), 5000);
    stopTimer.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    child = spawn(process.execPath, [
      resolve(root, "node_modules/tiktok-minis-cli/dist/index.js"),
      "dev", "--client-key", prepared.identity.VITE_TIKTOK_CLIENT_KEY,
    ], {
      cwd: prepared.directory,
      env: { ...process.env, ...prepared.identity },
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        if (interrupted) return resolveExit(130);
        if (exitCode !== 0) return reject(new Error(`Minis CLI exited with ${signal || `code ${exitCode}`}`));
        resolveExit(0);
      });
    });
    return code;
  } finally {
    clearTimeout(stopTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    signalCli(child, "SIGTERM");
    await removeDevDirectory(prepared.directory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMinisDev(process.cwd(), argumentValue(process.argv, "--app")).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(JSON.stringify({ level: "error", event: "minis_dev_failed", error: error.message }));
    process.exitCode = 1;
  });
}
