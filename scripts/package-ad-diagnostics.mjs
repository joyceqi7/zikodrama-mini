import { spawnSync, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { build } from "vite";
import { selectApplication, argumentValue } from "./app-selector.mjs";
import { buildMinisConfig, loadApplicationProfile, profileEnvironment } from "./package-minis.mjs";

// 专用入口只允许 Sandbox；既不修改消费者入口，也不覆盖正式 minis.zip。
const root = process.cwd();
const app = await selectApplication({ root, appId: argumentValue(process.argv, "--app"), action: "广告诊断打包", interactive: false });
const env = profileEnvironment(await loadApplicationProfile(root, app.tiktokAppId), "sandbox");
if (env.VITE_API_BASE_URL !== "https://api.zikodrama-tv.com") throw new Error("Ad diagnostics must use the test service");
const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const config = { tiktokAppId: app.tiktokAppId, name: app.name, apiBaseUrl: env.VITE_API_BASE_URL, build: `${revision}-ad-diag-2` };
const output = resolve(root, ".artifacts", "ad-diagnostics", app.tiktokAppId);
const bundle = resolve(output, "bundle");
await mkdir(output, { recursive: true });
const checked = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.ad-diagnostics.json", "--pretty", "false"], { cwd: root, stdio: "inherit" });
if (checked.status !== 0) process.exit(checked.status ?? 1);
await build({ configFile: false, root: resolve(root, "diagnostics/ads"), base: "./",
  define: { __AD_DIAG_CONFIG__: JSON.stringify(config), __MINI_BUILD_ID__: JSON.stringify(config.build) },
  plugins: [{ name: "diagnostic-app-identity", transformIndexHtml: { order: "pre", handler: html => html.replaceAll("%VITE_TIKTOK_CLIENT_KEY%", env.VITE_TIKTOK_CLIENT_KEY) } }],
  build: { outDir: bundle, emptyOutDir: true },
});
const minis = buildMinisConfig(JSON.parse(await readFile(resolve(root, "minis.config.json"), "utf8")), {
  apiBaseURL: env.VITE_API_BASE_URL,
});
await writeFile(resolve(output, "minis.config.json"), JSON.stringify({ ...minis, build: { outputDir: bundle, htmlEntry: resolve(bundle, "index.html") } }, null, 2));
const cli = spawnSync(process.execPath, [resolve(root, "node_modules/tiktok-minis-cli/dist/index.js"), "build", "--no-zip"], { cwd: output, stdio: "inherit" });
if (cli.status !== 0) process.exit(cli.status ?? 1);
// 上传配置只保留包内相对路径，避免将本机绝对构建路径带入平台预览包。
await writeFile(resolve(bundle, "minis.config.json"), JSON.stringify({ ...minis, build: { outputDir: "dist", htmlEntry: "index.html" } }, null, 2));
const archive = resolve(output, "minis.zip");
await rm(archive, { force: true });
const zipped = spawnSync("zip", ["-qr", archive, "."], { cwd: bundle, stdio: "inherit" });
if (zipped.status !== 0) process.exit(zipped.status ?? 1);
await writeFile(resolve(dirname(archive), "manifest.json"), JSON.stringify(config, null, 2));
console.info(JSON.stringify({ event: "ad_diagnostic_package_ready", ...config, archive }));
