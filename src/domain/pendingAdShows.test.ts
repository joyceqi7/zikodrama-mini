import { expect, it, vi } from "vitest";
import { createMemoryStorage } from "./browserStorage";
import { PendingAdShowStore } from "./pendingAdShows";

it("补报保留期使用服务器基准，手机改时间不提前删除；重试不重置原保留期", () => {
  const storage = createMemoryStorage();
  let serverNow: number | undefined = Date.parse("2026-10-23T12:00:00Z");
  const initial = serverNow;
  const store = new PendingAdShowStore(storage, "app:A", () => serverNow);
  const show = { eventId: "retained-show", scene: "home_entry", adUnitId: "ad" };
  store.add(show);
  const phone = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2036-01-01T00:00:00Z"));
  try {
    expect(store.list()).toHaveLength(1);
    serverNow = undefined;
    expect(new PendingAdShowStore(storage, "app:A", () => serverNow).list()).toHaveLength(1);
    serverNow = initial + 47 * 3600_000;
    store.add(show);
    expect(store.list()[0].queuedAtServer).toBe(initial);
    serverNow = initial + 48 * 3600_000;
    expect(store.list()).toEqual([]);
  } finally { phone.mockRestore(); }
});

it("旧手机时间记录等到新服务器基准才开始保留期，不把旧客户端日期当清理依据", () => {
  const storage = createMemoryStorage();
  storage.setItem("tiktok_minis_pending_ad_shows:app:A", JSON.stringify([{ eventId: "legacy-key", scene: "home_entry", adUnitId: "ad", occurredAt: "2001-01-01T00:00:00Z" }]));
  let serverNow: number | undefined;
  const store = new PendingAdShowStore(storage, "app:A", () => serverNow);
  expect(store.list()).toHaveLength(1);
  serverNow = Date.parse("2026-10-23T12:00:00Z");
  expect(store.list()[0]).toMatchObject({ occurredAt: "2001-01-01T00:00:00Z", queuedAtServer: serverNow });
});

it("通用队列保存有内容和无内容场景，外部修改不能改写原始展示", () => {
  const storage = createMemoryStorage();
  const store = new PendingAdShowStore(storage, "app:A");
  const entry = { eventId: "entry-event", scene: "entry_reward", adUnitId: "ad", dramaId: "9007199254740993", occurredAt: "2026-10-08T09:00:00.000Z" };
  const home = { eventId: "home-event", scene: "home_entry", adUnitId: "home-ad", occurredAt: entry.occurredAt };
  store.add(entry); store.add(home);
  home.adUnitId = "changed";
  const read = store.list();
  read[1].adUnitId = "modified";
  expect(new PendingAdShowStore(storage, "app:A").list()[1].adUnitId).toBe("home-ad");
  store.remove(entry.eventId);
  expect(store.list()).toHaveLength(1);
});

it("展示事实持久保存、用户隔离，存储写故障恢复后不复活已确认事实", () => {
  const storage = createMemoryStorage();
  const a = new PendingAdShowStore(storage, "app:A");
  const show = { eventId: "entry-show", scene: "entry_reward", occurredAt: new Date().toISOString(), adUnitId: "ad", dramaId: "201" };
  a.add(show);
  expect(new PendingAdShowStore(storage, "app:A").list()).toEqual([show]);
  expect(new PendingAdShowStore(storage, "app:B").list()).toEqual([]);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const write = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
  a.remove(show.eventId);
  expect(a.list()).toEqual([]);
  expect(log.mock.calls.some(call => JSON.stringify(call).includes("quota exceeded"))).toBe(true);
  write.mockRestore();
  expect(a.list()).toEqual([]);
  expect(new PendingAdShowStore(storage, "app:A").list()).toEqual([]);
  log.mockRestore();
});
