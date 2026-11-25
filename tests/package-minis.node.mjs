import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveMinisOutput,
  buildMinisConfig,
  campaignPreviewMeta,
  injectPreviewConsole,
  mergeApplicationProfile,
  profileEnvironment,
  validatePublicBuildInputs,
} from "../scripts/package-minis.mjs";

test("仅当打包参数给出合法投放码时生成预览标记", () => {
  assert.equal(campaignPreviewMeta(), "");
  assert.equal(campaignPreviewMeta("demo_campaign-01"), '<meta name="minis-preview-campaign" content="demo_campaign-01">');
  for (const invalid of ["", "--deployment", 'a"><script>', "a".repeat(65), 42, null]) {
    assert.throws(() => campaignPreviewMeta(invalid), /preview-campaign/);
  }
});

test("版本二维码复用短链的公开展示参数，拒绝其他参数与 HTML 注入", () => {
  const path = "/?campaignCode=demo_campaign-01&coverTitle=%22TV%22&coverEpisodeCount=20";
  assert.equal(campaignPreviewMeta(undefined, path),
    '<meta name="minis-preview-campaign" content="demo_campaign-01" data-launch-query="coverTitle=%22TV%22&amp;coverEpisodeCount=20">');
  for (const invalid of [path + "&episodeId=18426", path + "&coverEpisodeCount=5", "https://example.com" + path]) {
    assert.throws(() => campaignPreviewMeta(undefined, invalid), /preview-launch-path/);
  }
  assert.throws(() => campaignPreviewMeta("other", path), /Use only one/);
});

test("Sandbox 日志面板只注入标记，不在 HTML 中加载外部诊断脚本阻塞启动", () => {
  const html = "<head></head><body></body>";
  assert.equal(injectPreviewConsole(html, "production", { previewConsole: true }), html);
  assert.equal(injectPreviewConsole(html, "sandbox", { previewConsole: false }), html);
  const preview = injectPreviewConsole(html, "sandbox", { previewConsole: true });
  assert.ok(preview.includes("window.__PLAYBACK_PREVIEW_CONSOLE__=true"));
  assert.ok(!preview.includes("vConsole.js"));
  assert.ok(!preview.includes("src="));
});

const baseConfig = {
  domain: {
    trustedDomains: [],
  },
};

test("生产包只注入 H5 直接访问的 API Origin", () => {
  const result = buildMinisConfig(baseConfig, {
    apiBaseURL: "https://api.drama.test",
  });
  assert.deepEqual(result.domain.trustedDomains, ["https://api.drama.test"]);
  assert.equal(
    new Set(result.domain.trustedDomains).size,
    result.domain.trustedDomains.length,
  );
});

test("生产包保留四份 License 自动更新所需的可信请求域名", async () => {
  const configured = JSON.parse(await readFile("minis.config.json", "utf8"));
  const licenses = JSON.parse(await readFile("src/config/veplayer-licenses.json", "utf8"));
  const result = buildMinisConfig(configured, { apiBaseURL: "https://api.drama.test" });
  assert.equal(licenses.domains.length, 4);
  assert.ok(result.domain.trustedDomains.includes("https://api.drama.test"));
  for (const { domain, appId, licenseFile } of licenses.domains) {
    const license = JSON.parse(await readFile(join("src/assets/veplayer", licenseFile), "utf8"));
    const content = JSON.parse(Buffer.from(license.Content, "base64").toString("utf8"));
    assert.equal(content.WildcardDomain, `*.${domain}`);
    assert.ok(licenseFile.endsWith(`-a-${appId}.lic`));
    for (const field of ["MainURL", "BackupURL"]) {
      const origin = new URL(license[field]).origin;
      assert.ok(result.domain.trustedDomains.includes(origin), `${domain} ${field} must be trusted`);
    }
  }
});

test("生产打包拒绝占位符和不完整的应用公开配置", () => {
  assert.throws(
    () =>
      buildMinisConfig(baseConfig, {
        apiBaseURL: "https://api.example.com",
      }),
    /placeholders/,
  );
  assert.throws(
    () =>
      validatePublicBuildInputs({
        tiktokAppId: "0009007199254740993123",
        appName: "Drama Minis",
        appLogoURL: "https://cdn.drama.test/logo.png",
        apiBaseURL: "https://api.drama.test",
        clientKey: "replace_with_client_key",
      }),
    /client/i,
  );
  assert.throws(
    () =>
      validatePublicBuildInputs({
        tiktokAppId: "0009007199254740993123",
        appName: "Drama Minis",
        appLogoURL: "http://cdn.drama.test/logo.png",
        apiBaseURL: "https://api.drama.test",
        clientKey: "client-key",
      }),
    /logo.*https/i,
  );
});

test("应用配置仅映射 Mini 包路由和可信域名", () => {
  const environment = profileEnvironment({
    tiktokAppId: "0009007199254740993123",
    name: "Alpha Drama",
    logoUrl: "https://cdn.alpha.test/logo.png",
    clientKey: "client-alpha",
    apiBaseUrl: "https://api.alpha.test",
  });

  assert.equal(environment.VITE_TIKTOK_APP_ID, "0009007199254740993123");
  assert.equal(environment.VITE_APP_LOGO_URL, "https://cdn.alpha.test/logo.png");
  assert.equal(environment.VITE_TIKTOK_CLIENT_KEY, "client-alpha");
  assert.equal(environment.VITE_VOLCENGINE_VOD_APP_ID, undefined);
  assert.equal(environment.VITE_VEPLAYER_LICENSE, undefined);
});

test("同一应用按部署目标使用隔离的 Sandbox 和 Production 端点", () => {
  const profile = {
    tiktokAppId: "0009007199254740993123",
    name: "Alpha Drama",
    logoUrl: "https://cdn.alpha.test/logo.png",
    clientKey: "client-alpha",
    deployments: {
      sandbox: {
        apiBaseUrl: "https://api.sandbox.alpha.test",
      },
      production: {
        apiBaseUrl: "https://api.alpha.test",
      },
    },
  };

  const sandbox = profileEnvironment(profile, "sandbox");
  const production = profileEnvironment(profile, "production");

  assert.equal(sandbox.VITE_TIKTOK_APP_ID, production.VITE_TIKTOK_APP_ID);
  assert.equal(
    sandbox.VITE_TIKTOK_CLIENT_KEY,
    production.VITE_TIKTOK_CLIENT_KEY,
  );
  assert.equal(sandbox.VITE_API_BASE_URL, "https://api.sandbox.alpha.test");
  assert.equal(production.VITE_API_BASE_URL, "https://api.alpha.test");
});

test("Sandbox 打包缺少专用端点时拒绝回退 Production", () => {
  assert.throws(
    () =>
      profileEnvironment(
        {
          tiktokAppId: "0009007199254740993123",
          name: "Alpha Drama",
          logoUrl: "https://cdn.alpha.test/logo.png",
          clientKey: "client-alpha",
          apiBaseUrl: "https://api.alpha.test",
        },
        "sandbox",
      ),
    /sandbox.*deployment/i,
  );
});

test("Sandbox 部分配置也拒绝回退 Production", () => {
  assert.throws(
    () =>
      profileEnvironment(
        {
          tiktokAppId: "0009007199254740993123",
          name: "Alpha Drama",
          logoUrl: "https://cdn.alpha.test/logo.png",
          clientKey: "client-alpha",
          apiBaseUrl: "https://api.alpha.test",
          deployments: {
            sandbox: {},
          },
        },
        "sandbox",
      ),
    /sandbox.*apiBaseUrl/i,
  );
});

test("本地品牌覆盖不会制造空 Sandbox 配置", () => {
  const merged = mergeApplicationProfile(
    {
      tiktokAppId: "0009007199254740993123",
      name: "Alpha Drama",
      apiBaseUrl: "https://api.alpha.test",
    },
    { name: "Alpha Local" },
  );

  assert.equal(merged.name, "Alpha Local");
  assert.equal(merged.deployments, undefined);
});

test("本地部署覆盖按目标深合并且不修改另一环境", () => {
  const merged = mergeApplicationProfile(
    {
      deployments: {
        sandbox: {
          apiBaseUrl: "https://api.sandbox.alpha.test",
        },
        production: {
          apiBaseUrl: "https://api.alpha.test",
        },
      },
    },
    {
      deployments: {
        sandbox: {
          apiBaseUrl: "https://api.local-sandbox.alpha.test",
        },
      },
    },
  );

  assert.equal(
    merged.deployments.sandbox.apiBaseUrl,
    "https://api.local-sandbox.alpha.test",
  );
  assert.equal(
    merged.deployments.production.apiBaseUrl,
    "https://api.alpha.test",
  );
});

test("应用配置拒绝 Sandbox 与 Production 共用 API Origin", () => {
  assert.throws(
    () =>
      profileEnvironment(
        {
          tiktokAppId: "0009007199254740993123",
          name: "Alpha Drama",
          logoUrl: "https://cdn.alpha.test/logo.png",
          clientKey: "client-alpha",
          deployments: {
            sandbox: {
              apiBaseUrl: "https://api.alpha.test",
            },
            production: {
              apiBaseUrl: "https://api.alpha.test",
            },
          },
        },
        "sandbox",
      ),
    /sandbox.*production.*API/i,
  );
});

test("兼容旧 Production 字段时仍拒绝 Sandbox 共用端点", () => {
  assert.throws(
    () =>
      profileEnvironment(
        {
          tiktokAppId: "0009007199254740993123",
          name: "Alpha Drama",
          logoUrl: "https://cdn.alpha.test/logo.png",
          clientKey: "client-alpha",
          apiBaseUrl: "https://api.alpha.test",
          deployments: {
            sandbox: {
              apiBaseUrl: "https://api.alpha.test",
            },
          },
        },
        "sandbox",
      ),
    /sandbox.*production.*API/i,
  );
});

test("应用配置拒绝数字 AppID 与旧业务编码，不将 Client Key 当作 AppID", () => {
  const base = { name: "Drama", logoUrl: "https://cdn.drama.test/logo.png", clientKey: "sdk-client", apiBaseUrl: "https://api.drama.test" };
  for (const identity of [{ code: "business-code" }, { tiktokAppId: 9007199254740993 }, { tiktokAppId: "replace_with_tiktok_app_id" }, { tiktokAppId: "../other" }]) {
    assert.throws(() => profileEnvironment({ ...base, ...identity }), /tiktokAppId/);
  }
  assert.equal(profileEnvironment({ ...base, tiktokAppId: "0009007199254740993123" }).VITE_TIKTOK_CLIENT_KEY, "sdk-client");
});

test("多应用压缩包按所选 Client Key 分目录保存，不覆盖先前应用", async () => {
  const root = await mkdtemp(join(tmpdir(), "drama-mini-archive-"));
  const outputDir = join(root, "dist");
  const archiveRoot = join(root, "archives");
  await mkdir(outputDir);
  try {
    const writeApp = (key) => writeFile(join(outputDir, "index.html"),
      `<script>TTMinis.init({ clientKey: "${key}" })</script>`);
    await writeApp("client-alpha");
    const alpha = await archiveMinisOutput(outputDir, "client-alpha", archiveRoot);
    const alphaBytes = await readFile(alpha);

    await writeFile(join(outputDir, "index.html"), `<head>${campaignPreviewMeta("alpha-preview")}</head><script>TTMinis.init({ clientKey: "client-alpha" })</script>`);
    const alphaPreview = await archiveMinisOutput(outputDir, "client-alpha", archiveRoot);
    assert.equal(alphaPreview, join(archiveRoot, "client-alpha", "minis-campaign-preview.zip"));
    assert.deepEqual(await readFile(alpha), alphaBytes);

    await writeApp("client-beta");
    await assert.rejects(
      archiveMinisOutput(outputDir, "client-alpha", archiveRoot),
      /does not match/,
    );
    const beta = await archiveMinisOutput(outputDir, "client-beta", archiveRoot);

    assert.notEqual(alpha, beta);
    assert.deepEqual(await readFile(alpha), alphaBytes);
    assert.ok((await stat(beta)).size > 0);
    if (process.platform !== "win32") {
      for (const [archive, key] of [[alpha, "client-alpha"], [alphaPreview, "client-alpha"], [beta, "client-beta"]]) {
        const result = spawnSync("unzip", ["-p", archive, "index.html"], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(key));
        assert.equal(result.stdout.includes('content="alpha-preview"'), archive === alphaPreview);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("手填应用版本覆盖共享版本，拒绝模糊及非法版本", () => {
  const profile={tiktokAppId:"000123",name:"Version App",logoUrl:"https://assets.test/logo.png",clientKey:"version-client",apiBaseUrl:"https://api.test"};
  assert.equal(profileEnvironment({...profile,appVersion:"1.2.3"}).VITE_MINI_APP_VERSION,"1.2.3");
  assert.equal(profileEnvironment(profile).VITE_MINI_APP_VERSION,undefined);
  for(const appVersion of ["v1.2.3","01.2.3","1.2","1.2.3-beta",123,null]) assert.throws(()=>profileEnvironment({...profile,appVersion}),/appVersion/);
});
