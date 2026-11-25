import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadApplicationChoices, selectApplication } from "../scripts/app-selector.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "app-selector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "configs", "apps");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "111.json"), JSON.stringify({ tiktokAppId: "111", name: "Alpha", clientKey: "alpha-key" }));
  await writeFile(join(directory, "222.json"), JSON.stringify({ tiktokAppId: "222", name: "Beta", clientKey: "beta-key" }));
  await writeFile(join(directory, "example.json"), JSON.stringify({ tiktokAppId: "replace_with_tiktok_app_id" }));
  await writeFile(join(directory, "111.local.json"), JSON.stringify({ name: "Local Alpha" }));
  return root;
}

test("只列出真实应用并按 AppID 显式选择", async (t) => {
  const root = await fixture(t);
  const choices = await loadApplicationChoices(root);
  assert.deepEqual(choices.map((item) => item.tiktokAppId), ["111", "222"]);
  assert.equal((await selectApplication({ root, appId: "222", interactive: false })).name, "Beta");
});

test("交互菜单返回选择的应用，非交互环境必须传 --app", async (t) => {
  const root = await fixture(t);
  let received;
  const selected = await selectApplication({
    root,
    action: "预览",
    interactive: true,
    prompt: async (options) => { received = options; return "111"; },
  });
  assert.equal(selected.name, "Alpha");
  assert.match(received.message, /预览/);
  assert.equal(received.choices.length, 2);
  await assert.rejects(
    selectApplication({ root, action: "打包", interactive: false }),
    /requires --app/,
  );
});

test("不存在的 AppID 被明确拒绝", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    selectApplication({ root, appId: "999", interactive: false }),
    /configs\/apps\/999\.json/,
  );
});
