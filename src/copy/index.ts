import messages from "./messages";

/** text 返回固定英文文案，并替换业务计数等占位符；不读取设备或请求语言。 */
export function text(key: string, values: Record<string, unknown> = {}): string {
  const lookup = (path: string): unknown => path.split(".").reduce<unknown>((value, part) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, messages);
  const plural = typeof values.count === "number" ? lookup(`${key}_${values.count === 1 ? "one" : "other"}`) : undefined;
  const value = plural ?? lookup(key);
  if (typeof value !== "string") throw new Error(`Unknown interface message: ${key}`);
  return value.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(values[name] ?? ""));
}
