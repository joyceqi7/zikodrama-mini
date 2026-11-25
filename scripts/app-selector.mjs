import select from "@inquirer/select";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PLACEHOLDER = /replace_with/i;

function requiredText(name, value, fileName) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || PLACEHOLDER.test(normalized)) {
    throw new Error(`${fileName} must configure ${name}`);
  }
  return normalized;
}

function requiredIdentifier(name, value, fileName) {
  const normalized = requiredText(name, value, fileName);
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(normalized)) {
    throw new Error(`${fileName} must configure a valid ${name}`);
  }
  return normalized;
}

/** loadApplicationChoices 读取真实应用配置；示例和本机覆盖文件不进入选择菜单。 */
export async function loadApplicationChoices(root = process.cwd()) {
  const directory = resolve(root, "configs", "apps");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".local.json") && name !== "example.json")
    .sort();
  const applications = [];
  for (const fileName of names) {
    const profile = JSON.parse(await readFile(resolve(directory, fileName), "utf8"));
    const fileAppId = fileName.slice(0, -5);
    const tiktokAppId = requiredIdentifier("tiktokAppId", profile.tiktokAppId, fileName);
    if (tiktokAppId !== fileAppId) {
      throw new Error(`${fileName} tiktokAppId must match file name`);
    }
    applications.push({
      tiktokAppId,
      name: requiredText("name", profile.name, fileName),
      clientKey: requiredIdentifier("clientKey", profile.clientKey, fileName),
      configPath: resolve(directory, fileName),
    });
  }
  if (applications.length === 0) {
    throw new Error("no application profiles found in configs/apps");
  }
  return applications;
}

/** selectApplication 显式参数优先；人工终端才展示菜单，CI 必须传 --app。 */
export async function selectApplication({
  root = process.cwd(),
  appId = "",
  action = "操作",
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt = select,
} = {}) {
  const applications = await loadApplicationChoices(root);
  const requested = String(appId || "").trim();
  if (requested) {
    const application = applications.find((item) => item.tiktokAppId === requested);
    if (!application) {
      throw new Error(`application profile not found: configs/apps/${requested}.json`);
    }
    return application;
  }
  if (!interactive) {
    throw new Error(`non-interactive ${action} requires --app <TikTok App ID>`);
  }
  const selectedID = await prompt({
    message: `请选择需要${action}的 TikTok Minis 应用`,
    choices: applications.map((application) => ({
      name: `${application.name}  ${application.tiktokAppId}`,
      value: application.tiktokAppId,
      description: application.configPath,
    })),
  });
  return applications.find((application) => application.tiktokAppId === selectedID);
}

export function argumentValue(args, name) {
  const direct = args.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}
