import { logClientEvent, safeErrorMessage } from "../observability/clientLog";

/** createMemoryStorage 提供当前页面内的 Storage 替身，不承诺退出后的持久化。 */
export function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

const pageFallback = createMemoryStorage();

/** browserStorage 连 Storage getter 被宿主禁用时也允许启动；数据仍由各 Store 按主体隔离。 */
export function browserStorage(): Storage {
  try { return window.localStorage; }
  catch (reason) {
    logClientEvent("warn", "browser_storage_unavailable", { error: safeErrorMessage(reason) });
    return pageFallback;
  }
}
