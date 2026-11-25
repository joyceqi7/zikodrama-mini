import { afterEach, expect, it, vi } from "vitest";
import { CoverLoader } from "./coverLoader";

afterEach(() => vi.unstubAllGlobals());
it("所有已登记图片最终请求，相同资源共享任务，失败释放名额", async () => {
  const images: { src: string; onload?: () => void; onerror?: () => void }[] = [];
  vi.stubGlobal("Image", class { src = ""; constructor() { images.push(this); } });
  const loader = new CoverLoader(2);
  const a = loader.request("/a", "low");
  expect(loader.request("/a", "high")).toBe(a);
  loader.request("/b", "high"); loader.request("/c", "high"); loader.request("/d", "low");
  expect(images.map(i => i.src)).toEqual(["/a", "/b"]);
  images[0].onerror?.();
  await Promise.resolve();
  expect(images.map(i => i.src)).toContain("/c");
  images[1].onload?.(); await Promise.resolve();
  expect(images.map(i => i.src)).toContain("/d");
  loader.dispose();
});
it("屏外封面不能占满下载名额，迟到的首屏封面立即开始", () => {
  const images: { src: string }[] = [];
  vi.stubGlobal("Image", class { src = ""; constructor() { images.push(this); } });
  const loader = new CoverLoader(4);
  for (let index = 0; index < 6; index++) loader.request(`/offscreen-${index}`, "low");
  expect(images.map(image => image.src)).toEqual(["/offscreen-0", "/offscreen-1"]);
  loader.request("/first-screen", "high");
  expect(images.map(image => image.src)).toContain("/first-screen");
  loader.dispose();
});
it("热播先返回时也为晚到的主轮播封面保留名额", () => {
  const images: { src: string }[] = [];
  vi.stubGlobal("Image", class { src = ""; constructor() { images.push(this); } });
  const loader = new CoverLoader(4);
  for (let index = 0; index < 4; index++) loader.request(`/hot-${index}`, "auto");
  expect(images.map(image => image.src)).toEqual(["/hot-0", "/hot-1", "/hot-2"]);
  loader.request("/hero", "high");
  expect(images.map(image => image.src)).toContain("/hero");
  loader.dispose();
});
it("解码完成才标记可展示，资源版本和域名独立", async () => {
  let finish!: () => void;
  const images: { src: string; onload?: () => void }[] = [];
  vi.stubGlobal("Image", class { src = ""; decode = () => new Promise<void>(resolve => { finish = resolve; }); constructor() { images.push(this); } });
  const loader = new CoverLoader();
  const a = loader.request("https://test.example/a?v=1");
  expect(loader.request("https://prod.example/a?v=1")).not.toBe(a);
  expect(loader.request("https://test.example/a?v=2")).not.toBe(a);
  images[0].onload?.();
  expect(a.snapshot().status).toBe("loading");
  finish(); await Promise.resolve(); await Promise.resolve();
  expect(a.snapshot().status).toBe("ready");
  // 预请求节点只负责填充 HTTP 缓存和发出就绪信号；完成后必须释放其解码位图。
  expect(images[0].src).toBe("");
  loader.dispose();
});
