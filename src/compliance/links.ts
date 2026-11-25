export type ComplianceLinkKey = "privacy" | "terms" | "support";

export interface ComplianceLink {
  key: ComplianceLinkKey;
  href: string;
}

const paths: Record<ComplianceLinkKey, string> = {
  privacy: "privacy/",
  terms: "terms/",
  support: "support/",
};

export function complianceLinks(
  configuredBase: string,
  allowInsecureLoopback = import.meta.env.DEV,
): ComplianceLink[] {
  if (!configuredBase) return [];
  try {
    const base = new URL(configuredBase);
    const isLoopback =
      base.hostname === "localhost" ||
      base.hostname === "127.0.0.1" ||
      base.hostname === "[::1]";
    const isAllowedProtocol =
      base.protocol === "https:" ||
      (allowInsecureLoopback && base.protocol === "http:" && isLoopback);
    if (!isAllowedProtocol || base.username || base.password) return [];
    base.search = "";
    base.hash = "";
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return (Object.keys(paths) as ComplianceLinkKey[]).map((key) => ({
      key,
      href: new URL(paths[key], base).toString(),
    }));
  } catch {
    return [];
  }
}
