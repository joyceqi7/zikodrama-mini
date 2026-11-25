import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("本机开发使用 HTTPS 测试 API，避免浏览器拦截 HTTP IP 直连", async () => {
  const environment = await readFile(resolve(projectRoot, ".env.development"), "utf8");
  const apiBaseUrl = environment.match(/^VITE_API_BASE_URL=(.+)$/m)?.[1]?.trim();

  assert.ok(apiBaseUrl, "VITE_API_BASE_URL is required");
  const url = new URL(apiBaseUrl);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "api.zikodrama-tv.com");
});
