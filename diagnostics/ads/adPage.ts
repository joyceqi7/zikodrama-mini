import { ensureTikTokSDK } from "../../src/platform/tiktok/sdkReady";
import { requestSilentLoginCode } from "../../src/platform/tiktok/login";
import { readTikTokSystemInfo } from "../../src/platform/tiktok/systemInfo";
import { AdDiagnosticRunner, type AdDiagnosticEvent } from "../../src/platform/tiktok/adDiagnosticRunner";
import { HttpMiniDramaApi } from "../../src/api/httpMiniDramaApi";
import { userMessage } from "../../src/api/userMessage";
import { logClientEvent, safeErrorMessage } from "../../src/observability/clientLog";

/** __AD_DIAG_CONFIG__ 由专用打包器固定应用与 Sandbox API，页面查询参数不能覆盖。 */
declare const __AD_DIAG_CONFIG__: { tiktokAppId: string; name: string; apiBaseUrl: string; build: string };
const config = __AD_DIAG_CONFIG__;
const api = new HttpMiniDramaApi(config.apiBaseUrl);
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const text = (id: string, value: string) => { element(id).textContent = value; };
const entries: Array<AdDiagnosticEvent & { observedAt: string; sinceTestMs: number }> = [];
let runner: AdDiagnosticRunner | undefined;
let connected = false;
let startedAt = performance.now();
let userId = "";
let system: { platform?: string; version?: string } | undefined;
const slots: Partial<Record<"rewarded" | "interstitial", string>> = {};

function updateControls() {
  const kind = element<HTMLSelectElement>("kind").value as "rewarded" | "interstitial";
  const blocked = !runner || runner.busy || runner.requiresReopen || !slots[kind];
  button("burst").disabled = blocked;
  button("show").disabled = blocked;
  button("stop").disabled = !runner?.busy;
  button("probe").disabled = !runner?.canProbe;
}

function observe(event: AdDiagnosticEvent) {
  entries.push({ ...event, observedAt: new Date().toISOString(), sinceTestMs: Math.round(performance.now() - startedAt) });
  // 测试日志只包含白名单数值和广告位，不保存 SDK 原始对象、OpenID 或凭据。
  logClientEvent(event.errorCode ? "warn" : "info", "ad_diagnostic", { ...event });
  const creates = entries.filter(e => e.source === "create_call").length;
  const shows = entries.filter(e => e.source === "show_call").length;
  const first = entries.find(e => e.errorCode === "30001");
  text("summary", `Creates: ${creates} · Shows: ${shows}\n${first ? `First observed 30001: ${first.attempt ? `attempt ${first.attempt}` : `unattributed; after ${first.observedAfterCreates} creates`}, source ${first.source}, showCalled=${first.showCalled ?? "unknown"}, +${first.sinceTestMs}ms` : "30001 not observed in this run"}`);
  text("events", entries.slice(-100).map(e => `#${e.attempt} +${e.sinceTestMs}ms ${e.kind} ${e.source} ${e.errorCode ?? ""}${e.subErrorCode ? `/${e.subErrorCode}` : ""}${e.isEnded === undefined ? "" : ` isEnded=${e.isEnded}`} (${e.elapsedMs}ms)${e.errorMessage ? ` ${e.errorMessage}` : ""}`).join("\n"));
  if (event.errorCode) text("status", `Stopped on error ${event.errorCode}. Source: ${event.source}. Preserve this log; close and reopen the Mini before retrying.`);
  if (event.source.endsWith("unconfirmed")) text("status", "Native result is unconfirmed. No further ads will start until the native terminal callback arrives.");
  if (event.source === "onClose") text("status", `Native closed. isEnded=${event.isEnded ?? "unknown"}. No reward requested.`);
  updateControls();
}

function failed(error: unknown) {
  logClientEvent("error", "ad_diagnostic_action_failed", { error: safeErrorMessage(error) });
  text("status", userMessage(error, "The diagnostic action could not be completed. Check the connection and reopen the Mini if necessary."));
  updateControls();
}

button("connect").onclick = async () => {
  if (connected) return;
  button("connect").disabled = true;
  try {
    await ensureTikTokSDK();
    const loginCode = await requestSilentLoginCode(window.TTMinis);
    const bootstrap = await api.bootstrap({ tiktokAppId: config.tiktokAppId, loginCode, launchQuery: {} });
    if (bootstrap.identityState !== "tiktok_authenticated") throw new Error("Official identity not confirmed");
    connected = true;
    userId = bootstrap.visitorId;
    system = await readTikTokSystemInfo(window.TTMinis);
    runner = new AdDiagnosticRunner(window.TTMinis!, observe);
    slots.interstitial = bootstrap.interstitialAdUnitId;
    slots.rewarded = bootstrap.vipOffer?.adUnitId;
    text("identity", `${config.name} · ${config.tiktokAppId}\nUID ${userId}\nBuild ${config.build}\n${system?.platform ?? "unknown"} / TikTok ${system?.version ?? "unknown"}\n${config.apiBaseUrl}`);
    const catalog = await api.publicCatalog(config.tiktokAppId, { limit: 20 });
    const select = element<HTMLSelectElement>("drama");
    select.replaceChildren(...catalog.dramas.map(drama => new Option(drama.title, drama.id)));
    button("read-slot").disabled = false;
    text("status", "Connected. Read a rewarded offer from a drama with locked episodes, or select Interstitial.");
    text("slots", `Interstitial: ${slots.interstitial ?? "not configured"} · Rewarded: ${slots.rewarded ?? "not yet read"}`);
    updateControls();
  } catch (error) { failed(error); button("connect").disabled = connected; }
};

button("read-slot").onclick = async () => {
  button("read-slot").disabled = true;
  try {
    const dramaId = element<HTMLSelectElement>("drama").value;
    const drama = await api.drama(dramaId);
    const episode = [...drama.episodes].reverse().find(item => item.accessMode === "rewarded");
    let slot: string | undefined;
    if (episode) {
      const permission = await api.resolvePlay(dramaId, episode.id);
      if (permission.status === "access_required" || permission.status === "reward_ad_required") slot = (permission.offers ?? [permission.offer]).find(offer => offer.adUnitId)?.adUnitId;
    }
    if (!slot) slot = (await api.entryAdStatus(dramaId)).offer?.adUnitId;
    slots.rewarded = slot;
    text("slots", `Interstitial: ${slots.interstitial ?? "not configured"}\nRewarded: ${slot ?? "no current offer; choose another drama"}`);
    text("status", slot ? "Server ad slot is ready. Choose a test." : "No rewarded offer for this drama. Choose another drama with locked episodes.");
  } catch (error) { failed(error); }
  finally { button("read-slot").disabled = false; updateControls(); }
};

button("burst").onclick = async () => {
  try {
    const kind = element<HTMLSelectElement>("kind").value as "rewarded" | "interstitial";
    startedAt = performance.now();
    text("status", "Creating instances only. Stop-on-error is active; late callbacks remain attributed to their original attempt.");
    const run = runner!.createBurst(kind, slots[kind]!, Number(element<HTMLInputElement>("count").value), Number(element<HTMLInputElement>("interval").value));
    updateControls(); await run;
    if (!entries.some(e => e.errorCode)) text("status", "Create scheduling ended. Keep this page open for late errors. Instance returned does not confirm loading. Close and reopen the Mini before another run.");
  } catch (error) { failed(error); }
  finally { updateControls(); }
};

button("show").onclick = () => {
  try {
    const kind = element<HTMLSelectElement>("kind").value as "rewarded" | "interstitial";
    text("status", "Single native ad request. Close it manually to finish; no automatic next ad and no reward claim.");
    runner!.showOnce(kind, slots[kind]!); updateControls();
  } catch (error) { failed(error); }
};
button("probe").onclick = () => {
  try {
    text("status", "Probing the last existing instance. A show rejection may be a forwarded initialization error; no stage or cancellation cause is assumed.");
    runner!.probeLastCreated(); updateControls();
  } catch (error) { failed(error); }
};
button("stop").onclick = () => { runner?.stop(); text("status", "Further creates stopped. Native instances and late callbacks are not treated as closed."); updateControls(); };
element("kind").onchange = updateControls;
button("export").onclick = () => {
  element<HTMLTextAreaElement>("json").value = JSON.stringify({ config, userId, system, entries }, null, 2);
  element<HTMLTextAreaElement>("json").select();
};
window.addEventListener("pagehide", () => runner?.dispose(), { once: true });
