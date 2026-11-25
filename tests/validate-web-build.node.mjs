import assert from "node:assert/strict";
import test from "node:test";

import { validateWebBuildInputs } from "../scripts/validate-web-build.mjs";

test("生产镜像构建要求受信任的 Mini 包身份与 HTTPS API 域名", () => {
  assert.doesNotThrow(() =>
    validateWebBuildInputs({
      tiktokAppId: "0009007199254740993123",
      apiBaseUrl: "https://api.drama.test",
      clientKey: "client-key",
    }),
  );
  assert.throws(() =>
    validateWebBuildInputs({
      tiktokAppId: "0009007199254740993123",
      apiBaseUrl: "http://localhost:8080",
      clientKey: "client-key",
    }),
  );
  assert.throws(() =>
    validateWebBuildInputs({
      tiktokAppId: "0009007199254740993123",
      apiBaseUrl: "https://api.drama.test",
      clientKey: "replace_with_tiktok_client_key",
    }),
  );
});
