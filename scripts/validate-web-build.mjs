const PLACEHOLDER = /(replace_with|your-domain|\.example(?:\.|[/:]|$)|localhost|127\.0\.0\.1)/i;

function requiredOrigin(name, input) {
  if (!input || PLACEHOLDER.test(input)) {
    throw new Error(`${name} must be configured without placeholders`);
  }
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

/** validateWebBuildInputs 校验官方 AppID、Client Key 和 HTTPS API，各标识保持独立。 */
export function validateWebBuildInputs(inputs) {
  const id = inputs.tiktokAppId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(id.trim()) || PLACEHOLDER.test(id)) {
    throw new Error("MINIS_TIKTOK_APP_ID must be a TikTok AppID string without placeholders");
  }
  if (!inputs.clientKey || PLACEHOLDER.test(inputs.clientKey)) {
    throw new Error("MINIS_TIKTOK_CLIENT_KEY must be configured");
  }
  requiredOrigin("MINIS_API_BASE_URL", inputs.apiBaseUrl);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  validateWebBuildInputs({
    tiktokAppId: process.env.MINIS_TIKTOK_APP_ID,
    apiBaseUrl: process.env.MINIS_API_BASE_URL,
    clientKey: process.env.MINIS_TIKTOK_CLIENT_KEY,
  });
}
