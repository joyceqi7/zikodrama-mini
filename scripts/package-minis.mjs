import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { argumentValue, loadApplicationChoices, selectApplication } from "./app-selector.mjs";

const PLACEHOLDER =
  /(replace_with|your-domain|\.example(?:\.|[/:]|$)|localhost|127\.0\.0\.1)/i;
const DEPLOYMENT_TARGETS = new Set(["sandbox", "production"]);
const CAMPAIGN_PREVIEW_META = '<meta name="minis-preview-campaign"';

function requiredOrigin(name, input) {
  if (!input || PLACEHOLDER.test(input))
    throw new Error(`${name} must be configured without placeholders`);
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a single HTTPS origin`);
  }
  return parsed.origin;
}

export function buildMinisConfig(baseConfig, inputs) {
  const apiOrigin = requiredOrigin("VITE_API_BASE_URL", inputs.apiBaseURL);
  const configured = baseConfig?.domain?.trustedDomains;
  if (!Array.isArray(configured))
    throw new Error("minis.config.json domain.trustedDomains must be an array");
  const trustedDomains = [...new Set([apiOrigin, ...configured])];
  if (trustedDomains.some((origin) => PLACEHOLDER.test(origin))) {
    throw new Error("trustedDomains contains a placeholder or local origin");
  }
  return {
    ...baseConfig,
    domain: { ...baseConfig.domain, trustedDomains },
  };
}

/** injectPreviewConsole 仅标记 Sandbox 诊断包，日志脚本由客户端在页面加载完成后异步获取，避免阻塞启动。 */
export function injectPreviewConsole(html, requestedTarget, diagnostics) {
  if (requestedTarget !== "sandbox" || diagnostics.previewConsole !== true) return html;
  return html.replace("</head>", `<script>window.__PLAYBACK_PREVIEW_CONSOLE__=true;</script>
</head>`);
}

/** campaignPreviewMeta 允许版本预览二维码复用服务端返回的 Mini 路径。 */
export function campaignPreviewMeta(code, launchPath) {
  let launchQuery = "";
  if (launchPath !== undefined) {
    if (code !== undefined) throw new Error("Use only one of --preview-campaign and --preview-launch-path");
    if (typeof launchPath !== "string" || !launchPath.startsWith("/?") || launchPath.includes("#")) {
      throw new Error("--preview-launch-path requires a Mini root path starting with /?");
    }
    const params = new URLSearchParams(launchPath.slice(2));
    code = params.get("campaignCode");
    for (const [name] of params) {
      if (!/^(campaignCode|coverDramaId|coverEpisodeId|coverKey|coverTitle|coverEpisodeNumber|coverEpisodeCount|platformDramaId|platformEpisodeId)$/.test(name) ||
          params.getAll(name).length !== 1) {
        throw new Error("--preview-launch-path contains an unsupported or repeated parameter");
      }
    }
    params.delete("campaignCode");
    // URLSearchParams 已编码 HTML 特殊字符，分隔符仍需转义后写入属性。
    launchQuery = params.toString().replaceAll("&", "&amp;");
  }
  if (code === undefined) return "";
  if (typeof code !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
    throw new Error("--preview-campaign or --preview-launch-path requires a valid campaign code");
  }
  return `${CAMPAIGN_PREVIEW_META} content="${code}"${launchQuery ? ` data-launch-query="${launchQuery}"` : ""}>`;
}

/** validatePublicBuildInputs 在调用官方打包工具前确认公开配置完整。 */
export function validatePublicBuildInputs(inputs) {
  requiredTikTokAppID(inputs.tiktokAppId);
  requiredProfileValue("VITE_APP_NAME", inputs.appName);
  requiredHTTPSURL("VITE_APP_LOGO_URL", inputs.appLogoURL);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(inputs.clientKey || "") || PLACEHOLDER.test(inputs.clientKey))
    throw new Error("VITE_TIKTOK_CLIENT_KEY must be a valid client key without placeholders");
  requiredOrigin("VITE_API_BASE_URL", inputs.apiBaseURL);
}

/** requiredTikTokAppID 拒绝数值及占位符，避免长标识符在 JSON 中丢失精度。 */
function requiredTikTokAppID(input) {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(input.trim()) || PLACEHOLDER.test(input)) {
    throw new Error("tiktokAppId must be a TikTok AppID string without placeholders");
  }
  return input.trim();
}

function requiredProfileValue(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized)
    throw new Error(`${name} must be configured in the application profile`);
  return normalized;
}

function requiredHTTPSURL(name, input) {
  const normalized = requiredProfileValue(name, input);
  if (PLACEHOLDER.test(normalized))
    throw new Error(`${name} must be configured without placeholders`);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error(`${name} must be a public HTTPS URL`);
  return parsed.toString();
}

function deploymentTarget(input = "production") {
  const target = String(input || "production")
    .trim()
    .toLowerCase();
  if (!DEPLOYMENT_TARGETS.has(target)) {
    throw new Error(
      `deployment target must be sandbox or production: ${target || "(empty)"}`,
    );
  }
  return target;
}

function comparableOrigin(input) {
  try {
    return new URL(String(input || "").trim()).origin.toLowerCase();
  } catch {
    return String(input || "")
      .trim()
      .toLowerCase();
  }
}

function deploymentProfile(profile, requestedTarget) {
  const target = deploymentTarget(requestedTarget);
  const deployments = profile?.deployments;
  const selected = deployments?.[target];
  if (target === "sandbox" && !selected) {
    throw new Error(
      "sandbox deployment must configure dedicated endpoints in deployments.sandbox",
    );
  }
  if (selected && !selected.apiBaseUrl) {
    throw new Error(
      `${target} deployment must configure apiBaseUrl`,
    );
  }

  const sandbox = deployments?.sandbox;
  const production =
    deployments?.production ||
    (profile?.apiBaseUrl ? profile : undefined);
  if (sandbox && production) {
    if (
      comparableOrigin(sandbox.apiBaseUrl) ===
      comparableOrigin(production.apiBaseUrl)
    ) {
      throw new Error(
        "sandbox and production API origins must be different",
      );
    }
  }

  return {
    ...profile,
    apiBaseUrl: selected ? selected.apiBaseUrl : profile?.apiBaseUrl,
  };
}

export function mergeApplicationProfile(baseProfile, overrideProfile) {
  const merged = {
    ...baseProfile,
    ...overrideProfile,
  };
  if (!baseProfile?.deployments && !overrideProfile?.deployments) {
    return merged;
  }

  const deployments = {
    ...baseProfile?.deployments,
    ...overrideProfile?.deployments,
  };
  for (const target of DEPLOYMENT_TARGETS) {
    if (
      baseProfile?.deployments?.[target] ||
      overrideProfile?.deployments?.[target]
    ) {
      deployments[target] = {
        ...baseProfile?.deployments?.[target],
        ...overrideProfile?.deployments?.[target],
      };
    } else {
      delete deployments[target];
    }
  }
  return {
    ...merged,
    deployments,
  };
}

/** profileEnvironment 将官方 AppID 与独立的 SDK Client Key 注入构建环境。 */
export function profileEnvironment(profile, requestedTarget = "production") {
  const configuredProfile = deploymentProfile(profile, requestedTarget);
  const tiktokAppId = requiredTikTokAppID(profile?.tiktokAppId);
  if (profile.appVersion !== undefined && (typeof profile.appVersion !== 'string' || profile.appVersion.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(profile.appVersion))) throw new Error('appVersion must be a three-part version such as 1.0.1');
  return {
    ...(profile.appVersion === undefined ? {} : {VITE_MINI_APP_VERSION:profile.appVersion}),
    VITE_TIKTOK_APP_ID: tiktokAppId,
    VITE_APP_NAME: requiredProfileValue("name", configuredProfile?.name),
    VITE_APP_LOGO_URL: requiredHTTPSURL(
      "logoUrl",
      configuredProfile?.logoUrl,
    ),
    VITE_TIKTOK_CLIENT_KEY: requiredProfileValue(
      "clientKey",
      configuredProfile?.clientKey,
    ),
    VITE_API_BASE_URL: requiredProfileValue(
      "apiBaseUrl",
      configuredProfile?.apiBaseUrl,
    ),
  };
}

export async function loadApplicationProfile(root, applicationId) {
  const tiktokAppId = requiredTikTokAppID(applicationId);
  const basePath = resolve(root, "configs", "apps", `${tiktokAppId}.json`);
  let profile;
  try {
    profile = JSON.parse(await readFile(basePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(
        `application profile not found: configs/apps/${tiktokAppId}.json`,
      );
    throw error;
  }
  const localPath = resolve(root, "configs", "apps", `${tiktokAppId}.local.json`);
  try {
    const local = JSON.parse(await readFile(localPath, "utf8"));
    profile = mergeApplicationProfile(profile, local);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (profile.tiktokAppId !== tiktokAppId)
    throw new Error("application profile tiktokAppId must match file name");
  return profile;
}

async function loadBuildEnvironment(root) {
  const values = {};
  for (const fileName of [".env.production", ".env.production.local"]) {
    try {
      Object.assign(
        values,
        parseEnv(await readFile(resolve(root, fileName), "utf8")),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { ...values, ...process.env };
}

function run(command, args, cwd, environment = process.env) {
  return new Promise((resolveRun, reject) => {
    // Windows 上 npm 与 node_modules/.bin 下的 CLI 是 .cmd 脚本，Node 须经 shell 启动；PowerShell 压缩仍直接启动。
    const viaShell = process.platform === "win32" && !/powershell(\.exe)?$/i.test(command);
    // 只给含空格的路径加引号：裸命令加引号会让 npm.cmd 把当前目录误当作自身所在目录。
    const shellCommand = viaShell && /\s/.test(command) ? `"${command}"` : command;
    const child = spawn(shellCommand, args, {
      cwd,
      stdio: "inherit",
      env: environment,
      shell: viaShell,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        reject(
          new Error(`TikTok Minis CLI failed (${signal || `exit ${code}`})`),
        );
    });
  });
}

/** archiveMinisOutput 按应用和包用途选择压缩包路径，避免投放预览覆盖标准包。 */
export async function archiveMinisOutput(outputDir, clientKey, archiveRoot = resolve(homedir(), "__TTMinis__")) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(clientKey))
    throw new Error("Client Key is not safe for an archive directory");
  const html = await readFile(resolve(outputDir, "index.html"), "utf8");
  const embeddedKey = html.match(/TTMinis\.init\(\s*\{[\s\S]*?clientKey\s*:\s*(['"`])([^'"`]+)\1/)?.[2];
  if (embeddedKey !== clientKey)
    throw new Error("Build Client Key does not match the selected application");

  const archiveDir = resolve(archiveRoot, clientKey);
  const archivePath = resolve(archiveDir, html.includes(CAMPAIGN_PREVIEW_META) ? "minis-campaign-preview.zip" : "minis.zip");
  const temporaryPath = resolve(archiveDir, `.minis-${randomUUID()}.zip`);
  await mkdir(archiveDir, { recursive: true });
  try {
    if (process.platform === "win32") {
      const escapedPath = temporaryPath.replace(/'/g, "''");
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
        "$files = Get-ChildItem -LiteralPath . -Force | ForEach-Object { $_.FullName }",
        'if (-not $files) { throw "No files found to archive." }',
        `Compress-Archive -LiteralPath $files -DestinationPath '${escapedPath}' -Force`,
      ].join("; ")], outputDir);
    } else {
      await run("zip", ["-qr", temporaryPath, "."], outputDir);
    }
    await rename(temporaryPath, archivePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  console.info(`TikTok Minis archive: ${archivePath}`);
  return archivePath;
}

/** packageMinis 按官方 AppID 选择公开配置并调用官方 CLI，结束后恢复配置文件。 */
export async function packageMinis(
  root = process.cwd(),
  tiktokAppId = "",
  requestedTarget = "",
  previewCampaign,
  previewLaunchPath,
) {
  const previewMeta = campaignPreviewMeta(previewCampaign, previewLaunchPath);
  const configPath = resolve(root, "minis.config.json");
  const original = await readFile(configPath, "utf8");
  const baseConfig = JSON.parse(original);
  let environment = await loadBuildEnvironment(root);
  // --app 选择配置文件；仅设置 VITE_TIKTOK_APP_ID 时使用环境变量模式。
  const selectedID = tiktokAppId || environment.MINIS_TIKTOK_APP_ID || "";
  const selectedTarget = deploymentTarget(
    requestedTarget || environment.MINIS_DEPLOYMENT_ENV || "production",
  );
  if (selectedID) {
    environment = {
      ...environment,
      ...profileEnvironment(
        await loadApplicationProfile(root, selectedID),
        selectedTarget,
      ),
    };
  }
  const inputs = {
    tiktokAppId: environment.VITE_TIKTOK_APP_ID,
    appName: environment.VITE_APP_NAME,
    appLogoURL: environment.VITE_APP_LOGO_URL,
    apiBaseURL: environment.VITE_API_BASE_URL,
    clientKey: environment.VITE_TIKTOK_CLIENT_KEY,
  };
  validatePublicBuildInputs(inputs);
  const productionConfig = buildMinisConfig(baseConfig, inputs);
  const childEnvironment = {
    ...process.env, ...environment,
    // 正式包优先使用本次打包目标，沿用的本地环境变量不能带入预览入口。
    VITE_MINIS_PREVIEW_BUILD: selectedTarget === "sandbox" || previewMeta ? "1" : "0",
  };
  try {
    await writeFile(
      configPath,
      `${JSON.stringify(productionConfig, null, 2)}\n`,
      "utf8",
    );
    await run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build:web"],
      root,
      childEnvironment,
    );
    const diagnostics = JSON.parse(await readFile(resolve(root, "src/config/playbackDiagnostics.json"), "utf8"));
    const entryPath = resolve(root, productionConfig.build.outputDir, "index.html");
    const html = await readFile(entryPath, "utf8");
    const entry = previewMeta ? html.replace("</head>", `${previewMeta}\n</head>`) : html;
    await writeFile(entryPath, injectPreviewConsole(entry, selectedTarget, diagnostics), "utf8");
    await run(
      resolve(root, "node_modules/.bin/minis"),
      ["build", "--no-zip"],
      root,
      childEnvironment,
    );
    await archiveMinisOutput(resolve(root, productionConfig.build.outputDir), inputs.clientKey);
  } finally {
    await writeFile(configPath, original, "utf8");
  }
}

const entryURL = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryURL) {
  const runPackaging = async () => {
    const selectedTarget = argumentValue(process.argv, "--deployment");
    const previewFlag = process.argv.some(arg => arg === "--preview-campaign" || arg.startsWith("--preview-campaign="));
    const previewCampaign = previewFlag ? argumentValue(process.argv, "--preview-campaign") : undefined;
    const pathFlag = process.argv.some(arg => arg === "--preview-launch-path" || arg.startsWith("--preview-launch-path="));
    const previewLaunchPath = pathFlag ? argumentValue(process.argv, "--preview-launch-path") : undefined;
    if (process.argv.includes("--all")) {
      if (previewFlag || pathFlag) throw new Error("Campaign preview must be used for a single application");
      const applications = await loadApplicationChoices(process.cwd());
      for (const application of applications)
        await packageMinis(process.cwd(), application.tiktokAppId, selectedTarget);
      return;
    }
    const application = await selectApplication({
      root: process.cwd(),
      appId: argumentValue(process.argv, "--app") || process.env.MINIS_TIKTOK_APP_ID,
      action: "打包",
    });
    console.info(`已选择：${application.name} (${application.tiktokAppId})`);
    await packageMinis(
      process.cwd(),
      application.tiktokAppId,
      selectedTarget,
      previewCampaign,
      previewLaunchPath,
    );
  };
  runPackaging().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
