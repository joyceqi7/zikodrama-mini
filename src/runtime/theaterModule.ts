import { preconnectMediaCDN } from "../config/mediaNetwork";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

let theaterModule: Promise<typeof import("../pages/theater")> | undefined;

/** loadTheaterModule 供惰性路由与明确观看意图共享同一个剧场代码入口。 */
export function loadTheaterModule(): Promise<typeof import("../pages/theater")> {
  preconnectMediaCDN();
  theaterModule ??= import("../pages/theater").catch(reason => {
    theaterModule = undefined;
    logClientEvent("warn", "theater_module_load_failed", { error: safeErrorMessage(reason) });
    throw reason;
  });
  return theaterModule;
}

/** preloadTheaterModule 提前准备剧场代码，路由和业务请求仍由实际导航触发。 */
export function preloadTheaterModule(): void {
  void loadTheaterModule().catch(() => { /* 共用的模块加载边界已记录失败原因。 */ });
}
