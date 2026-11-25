export type Id = string;

export function toId(value: string | number | bigint): Id {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Unsafe numeric identifier; provide platform IDs as strings");
    }
    return String(value);
  }
  const normalized = String(value).trim();
  if (!normalized) throw new Error("Identifier is required");
  return normalized;
}
