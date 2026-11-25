import { expect, it } from "vitest";
import configuration from "../config/veplayer-licenses.json";
import { readTopLevelHostname, selectVePlayerLicense } from "./vePlayerLicense";

const first = configuration.domains[0];
const path = `../assets/veplayer/${first.licenseFile}`;
const fixture = (changes: Record<string, unknown> = {}) => JSON.stringify({
  Content: btoa(JSON.stringify({ WildcardDomain: `*.${first.domain}` })),
  Signature: "test-only-signature",
  MainURL: "https://license.example/test.lic",
  ...changes,
});

it.each(configuration.domains)("真实随包许可覆盖 $domain 并保留原始签名和更新地址", ({ domain, appId }) => {
  const selected = selectVePlayerLicense(`minis-device-3.${domain}`);
  expect(selected.domain).toBe(domain);
  expect(selected.appId).toBe(appId);
  expect(Boolean(selected.license.content && selected.license.sign)).toBe(true);
  expect(new URL(selected.license.mainUrl).protocol).toBe("https:");
  expect(JSON.parse(atob(selected.license.content)).WildcardDomain).toBe(`*.${domain}`);
});

it("顶层域名匹配支持大小写、尾点及嵌套子域，拒绝拼接、伪造后缀和未知生产域名", () => {
  for (const host of ["MINIS.TIKTOK-MINIS.US.", "a.b.tiktok-minis.us", "tiktok-minis.us"]) {
    expect(selectVePlayerLicense(host).appId).toBe("1072774");
  }
  for (const host of [
    "minis-tiktok-minis.us", "tiktok-minis.us.evil.example", "example.com",
    "localhost.example", "127.0.0.2", "", "https://minis.tiktok-minis.us", ".tiktok-minis.us",
  ]) expect(() => selectVePlayerLicense(host)).toThrow();
});

it("本机调试使用配置文件指定的许可，不向未知页面域名回退", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(selectVePlayerLicense(host).domain).toBe(configuration.localDebugDomain);
  }
});

it("框架页面只读顶层域名，顶层不可读时保留读取错误且不选当前框架许可", () => {
  expect(readTopLevelHostname({ top: { location: { hostname: "MINIS.TIKTOKMINIS.US." } } } as Pick<Window, "top">))
    .toBe("minis.tiktokminis.us");
  const denied = { get top(): Window { throw new Error("Blocked a frame with origin https://private.example/?token=secret"); } };
  expect(() => readTopLevelHostname(denied)).toThrow("Blocked a frame with origin [URL]");
  expect(() => readTopLevelHostname({ top: null })).toThrow("hostname is empty");
});

it("缺少对应文件和域名错配时拒绝初始化，不使用其他许可", () => {
  expect(() => selectVePlayerLicense(`mini.${first.domain}`, {})).toThrow("license is missing");
  expect(() => selectVePlayerLicense(`mini.${first.domain}`, {
    [path]: fixture({ Content: btoa(JSON.stringify({ WildcardDomain: "*.tiktokminis.us" })) }),
  })).toThrow("does not match its configuration");
});

it.each([
  ["损坏 JSON", "{\"Content\":\"test-private-content"],
  ["空对象", "{}"],
  ["空值", "null"],
  ["损坏 Content", fixture({ Content: "test-private-content" })],
  ["空签名", fixture({ Signature: "" })],
  ["缺少更新地址", fixture({ MainURL: undefined })],
  ["非 HTTPS 地址", fixture({ MainURL: "http://license.example/test.lic" })],
  ["更新地址携带凭据", fixture({ MainURL: "https://account:secret@license.example/test.lic" })],
])("%s 拒绝且错误不包含许可或凭据", (_, raw) => {
  let message = "";
  try { selectVePlayerLicense(`mini.${first.domain}`, { [path]: raw }); }
  catch (reason) { message = (reason as Error).message; }
  expect(message).toContain("VePlayer license");
  expect(message).not.toContain("test-private-content");
  expect(message).not.toContain("test-only-signature");
  expect(message).not.toContain("secret");
  expect(message).not.toContain("https://");
});

it("mainUrl、Content、Signature 原样交给 SDK，不重新编码签名输入", () => {
  const raw = fixture();
  const original = JSON.parse(raw);
  const { license } = selectVePlayerLicense(`mini.${first.domain}`, { [path]: raw });
  expect(license).toEqual({ content: original.Content, sign: original.Signature, mainUrl: original.MainURL });
});
