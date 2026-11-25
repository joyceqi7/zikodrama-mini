import { userMessage } from "../api/userMessage";
import { text } from "../copy";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

/** showStartupError 将入口或界面模块失败统一转换为可重试的固定文案，原因为脱敏诊断所用。 */
export function showStartupError(reason: unknown): void {
  logClientEvent("error", "app_module_load_failed", { error: safeErrorMessage(reason) });
  const root = document.getElementById("root");
  if (!root) return;
  const screen = document.createElement("div");
  screen.className = "startup-screen error";
  screen.setAttribute("role", "alert");
  const mark = document.createElement("span");
  mark.className = "startup-mark";
  mark.textContent = "!";
  const title = document.createElement("strong");
  title.textContent = text("app.unableToStart");
  const message = document.createElement("small");
  message.textContent = userMessage(reason, text("app.initializeError"));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "primary-command";
  retry.textContent = text("common.retry");
  retry.onclick = () => window.location.reload();
  screen.append(mark, title, message, retry);
  root.replaceChildren(screen);
}
