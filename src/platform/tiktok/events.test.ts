import { afterEach, expect, test, vi } from "vitest";
import type { TikTokPostbackRecord } from "./events";
import { TikTokEventReporter } from "./events";
import type { TikTokMinisSDK } from "./types";
import type { DramaDetail } from "../../domain/types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const drama = { id: "9007199254740993", title: "Online series", episodeCount: 2, episodes: [{ id: "e1", number: 1 }, { id: "e2", number: 2 }] } as DramaDetail;

test("官方事件区分请求、实际播放和广告展示，数字样标识仍是字符串", () => {
  const reportEvent = vi.fn();
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK);
  reporter.identify("viewer-open-id", "mini-key", "Drama Minis");
  reporter.playback("video_play_request", drama, "e1");
  expect(reportEvent).toHaveBeenCalledTimes(1);
  reporter.playback("ep_play", drama, "e1");
  reporter.playback("ep_play", drama, "e1");
  reporter.rewardedAdShown();
  reporter.rewardedAdShown();
  expect(reportEvent.mock.calls.map(([event]) => event.eventName)).toEqual(["video_play_request", "ep_play", "minis_ad_show", "minis_ad_show"]);
  expect(reportEvent.mock.calls[2][0].params).toEqual({ minis_drama_id: drama.id, minis_drama_name: drama.title, episode_number: "1", if_last_ep: 0, if_first_time: 1, minis_name: "Drama Minis", minis_id: "mini-key", open_id: "viewer-open-id", ad_type: "RewardedVideoAd" });
  expect(reportEvent.mock.calls[3][0].params.if_first_time).toBe(0);
  reporter.playback("video_play_request", drama, "e2");
  reporter.playback("ep_play", drama, "e2");
  expect(reportEvent.mock.lastCall?.[0].params.if_last_ep).toBe(1);
});

test("缺少官方能力、播放事实或身份时不制造广告展示事件，异常不阻断业务", () => {
  const reportEvent = vi.fn();
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => false, reportEvent }) as unknown as TikTokMinisSDK);
  reporter.playback("video_play_request", drama, "e1");
  reporter.rewardedAdShown();
  expect(reportEvent).not.toHaveBeenCalled();
  const broken = new TikTokEventReporter(() => { throw new Error("private-provider-error"); });
  expect(() => broken.playback("video_play_request", drama, "e1")).not.toThrow();
});

test("账号切换清空上一账号的播放与首个广告上下文", () => {
  const reportEvent = vi.fn();
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK);
  reporter.identify("a", "mini", "App");
  reporter.playback("video_play_request", drama, "e1");
  reporter.playback("ep_play", drama, "e1");
  const oldShown = reporter.captureRewardedAd();
  reporter.identify("b", "mini", "App");
  oldShown();
  expect(reportEvent).toHaveBeenCalledTimes(2);
});


function reporterHarness() {
  const reportEvent = vi.fn();
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK);
  reporter.identify("viewer", "mini", "App");
  return { reporter, reportEvent };
}

test("直达锁定集仍报告广告展示，但不把目标集伪装成上一集播放", () => {
  const { reporter, reportEvent } = reporterHarness();
  reporter.playback("video_play_request", drama, "e2");
  reporter.captureRewardedAd(drama.id)();
  const event = reportEvent.mock.lastCall![0];
  expect(event.eventName).toBe("minis_ad_show");
  expect(event.params).toMatchObject({ minis_drama_id: drama.id, open_id: "viewer", if_first_time: 1, if_last_ep: null });
  expect(event.params).not.toHaveProperty("episode_number");
  expect(reportEvent.mock.calls.map(([value]) => value.eventName)).not.toContain("ep_play");
});

test("广告发起后切剧不会改绑，重复展示回调只回传一次", () => {
  const { reporter, reportEvent } = reporterHarness();
  reporter.playback("video_play_request", drama, "e1");
  reporter.playback("ep_play", drama, "e1");
  reporter.playback("video_play_request", drama, "e2");
  const shown = reporter.captureRewardedAd(drama.id);
  reporter.playback("video_play_request", { ...drama, id: "other-drama" }, "e2");
  shown(); shown();
  const ads = reportEvent.mock.calls.map(([value]) => value).filter((value) => value.eventName === "minis_ad_show");
  expect(ads).toHaveLength(1);
  expect(ads[0].params).toMatchObject({ minis_drama_id: drama.id, episode_number: "1" });
});

test("离开播放页后首页 VIP 广告不借用旧剧目信息，已有展示快照仍有效", () => {
  const { reporter, reportEvent } = reporterHarness();
  reporter.playback("video_play_request", drama, "e1");
  reporter.playback("ep_play", drama, "e1");
  const oldShown = reporter.captureRewardedAd(drama.id);
  reporter.clearPlaybackContext();
  oldShown();
  reporter.captureRewardedAd()();
  expect(reportEvent.mock.calls.at(-2)![0].params.episode_number).toBe("1");
  const params = reportEvent.mock.lastCall![0].params;
  expect(params).toMatchObject({ open_id: "viewer", minis_id: "mini", ad_type: "RewardedVideoAd", if_last_ep: null, if_first_time: null });
  expect(params).not.toHaveProperty("minis_drama_id");
  expect(params).not.toHaveProperty("episode_number");
});

test("换账号或应用阻止旧广告回调，同主体刷新不丢失展示", () => {
  const { reporter, reportEvent } = reporterHarness();
  const stale = reporter.captureRewardedAd();
  reporter.identify("other-viewer", "mini", "App");
  stale();
  expect(reportEvent).not.toHaveBeenCalled();
  const current = reporter.captureRewardedAd();
  reporter.identify("other-viewer", "mini", "App");
  current();
  expect(reportEvent).toHaveBeenCalledOnce();
  const otherApp = reporter.captureRewardedAd();
  reporter.identify("other-viewer", "other-mini", "App");
  otherApp();
  expect(reportEvent).toHaveBeenCalledOnce();
});

test("回传拒绝和抛错保留实际原因及脱敏，不能影响业务流程", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const message = "Report offline token=private-value";
  for (const reportEvent of [() => { throw new Error(message); }, (options: { callback(value: unknown): void }) => options.callback({ isSuccess: false, error: { error_msg: message, error_extra: { open_id: "private-id" } } })]) {
    const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK);
    expect(() => reporter.playback("video_play_request", drama, "e1")).not.toThrow();
  }
  expect(log).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith({
    event: "tiktok_event_failed", flow: "tiktok_event_postback", stage: "video_play_request",
    elapsedMs: expect.any(Number), outcome: expect.stringMatching(/rejected|exception/), error: "Report offline token=[REDACTED]",
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
});

test("关键行为用同一事实键记录回传尝试和平台结果", () => {
  const records: Array<{ id: string; event: string; outcome: string }> = [];
  const reportEvent = vi.fn((options: { callback(value: unknown): void }) => options.callback({ isSuccess: true }));
  const reporter = new TikTokEventReporter(
    () => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK,
    (record) => records.push(record),
  );
  reporter.playback("video_play_request", drama, "e1");
  expect(records).toEqual([
    expect.objectContaining({ event: "video_play_request", outcome: "attempt" }),
    expect.objectContaining({ event: "video_play_request", outcome: "success" }),
  ]);
  expect(records[0].id).toBe(records[1].id);
  expect(JSON.stringify(records)).not.toContain("viewer-open-id");
});

test("平台能力缺失记录未调用，记录器异常不阻断回传", () => {
  const records: Array<{ outcome: string }> = [];
  const unsupported = new TikTokEventReporter(
    () => ({ canIUse: () => false }) as unknown as TikTokMinisSDK,
    (record) => records.push(record),
  );
  expect(() => unsupported.playback("video_play_request", drama, "e1")).not.toThrow();
  expect(records.map((record) => record.outcome)).toEqual(["skipped"]);

  const reportEvent = vi.fn();
  const brokenRecorder = new TikTokEventReporter(
    () => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK,
    () => { throw new Error("record unavailable"); },
  );
  expect(() => brokenRecorder.playback("video_play_request", drama, "e1")).not.toThrow();
  expect(reportEvent).toHaveBeenCalledOnce();
});


test("入剧广告独立使用目录摘要，不伪造播放请求；明细脱敏且保留未知上一集", () => {
  const records: TikTokPostbackRecord[] = [];
  const reportEvent = vi.fn((options: { callback(value: unknown): void }) => options.callback({ isSuccess: true }));
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK, record => records.push(record));
  reporter.identify("private-viewer", "client-key", "My Mini");
  reporter.rememberDrama({ ...drama, episodeCount: 80 });
  reporter.captureRewardedAd(drama.id, "RewardedVideoAd", "entry_reward")();
  expect(reportEvent).toHaveBeenCalledOnce();
  expect(reportEvent.mock.calls[0][0]).toMatchObject({ eventName: "minis_ad_show", params: { minis_drama_id: drama.id, minis_drama_name: drama.title, open_id: "private-viewer", if_last_ep: null } });
  expect(records[1]).toMatchObject({ outcome: "success", details: { scene: "entry_reward", params: { open_id: "[REDACTED]" }, warnings: ["missing_previous_episode", "unknown_last_episode"], elapsedMs: expect.any(Number) } });
  expect(records[1].details.params).not.toHaveProperty("episode_number");
  expect(JSON.stringify(records)).not.toContain("private-viewer");
});

test("单集授权不误判最后一集，无回调为未知、迟到回调更新原事实且不重发", () => {
  vi.useFakeTimers();
  const records: TikTokPostbackRecord[] = [];
  let callback!: (value: unknown) => void;
  const reportEvent = vi.fn((options: { callback(value: unknown): void }) => { callback = options.callback; });
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK, record => records.push(record));
  reporter.playback("video_play_request", { ...drama, episodeCount: 80, episodes: [drama.episodes[0]] }, "e1");
  vi.advanceTimersByTime(10_000);
  expect(records.map(record => record.outcome)).toEqual(["attempt", "unknown"]);
  expect(records[0].details.params.if_last_ep).toBe(0);
  callback({ isSuccess: true }); callback({ isSuccess: false });
  expect(records.map(record => record.outcome)).toEqual(["attempt", "unknown", "success"]);
  expect(new Set(records.map(record => record.id)).size).toBe(1);
  expect(new Set(records.map(record => record.occurredAt)).size).toBe(1);
  expect(reportEvent).toHaveBeenCalledOnce();
});

test("身份切换后的迟到回调不会归给新用户，数值错误码与消息有界脱敏", () => {
  const records: TikTokPostbackRecord[] = [];
  let callback!: (value: unknown) => void;
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent: (options: { callback(value: unknown): void }) => { callback = options.callback; } }) as unknown as TikTokMinisSDK, record => records.push(record));
  reporter.identify("private-viewer", "key", "Mini");
  reporter.playback("video_play_request", drama, "e1");
  callback({ isSuccess: false, error: { error_code: 400, sub_error_code: 7, error_msg: "private-viewer token=secret https://secret.test/path" } });
  expect(records[1].details).toMatchObject({ errorCode: "400", subErrorCode: "7", reason: "sdk_rejected" });
  expect(JSON.stringify(records)).not.toMatch(/private-viewer|secret/);
  reporter.playback("video_play_request", drama, "e1");
  reporter.identify("another", "key", "Mini");
  callback({ isSuccess: true });
  expect(records.map(record => record.outcome)).toEqual(["attempt", "failure", "attempt"]);
});

test("慢目录补齐原剧名，保持展示时间、首次标记和上一集快照，重复回调不重传", async () => {
  vi.useFakeTimers();
  const records: TikTokPostbackRecord[] = [];
  const reportEvent = vi.fn((options: { callback(value: unknown): void }) => options.callback({ isSuccess: true }));
  const reporter = new TikTokEventReporter(() => ({ canIUse: () => true, reportEvent }) as unknown as TikTokMinisSDK, record => records.push(record));
  reporter.identify("private-viewer", "mini", "App");
  let resolve!: (value: typeof drama) => void;
  const context = new Promise<typeof drama>(done => { resolve = done; });
  const first = reporter.captureRewardedAd(drama.id, "RewardedVideoAd", "entry_reward", context);
  const second = reporter.captureRewardedAd(drama.id, "RewardedVideoAd", "entry_reward", context);
  const shownAt = new Date().toISOString();
  first(); first(); second();
  expect(reportEvent).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  reporter.playback("video_play_request", { ...drama, id: "other" }, "e2");
  reporter.playback("ep_play", { ...drama, id: "other" }, "e2");
  resolve(drama);
  await vi.advanceTimersByTimeAsync(0);
  const ads = reportEvent.mock.calls.map(([value]) => value as unknown as { eventName: string; params: Record<string, unknown> }).filter(value => value.eventName === "minis_ad_show");
  expect(ads).toHaveLength(2);
  expect(ads.map(ad => ad.params.if_first_time)).toEqual([1, 0]);
  expect(ads[0].params).toMatchObject({ minis_drama_id: drama.id, minis_drama_name: drama.title, if_last_ep: null });
  expect(ads[0].params).not.toHaveProperty("episode_number");
  const facts = records.filter(record => record.event === "minis_ad_show");
  expect(facts.every(record => record.occurredAt === shownAt)).toBe(true);
  expect(facts.every(record => !record.details.warnings.includes("missing_drama_context"))).toBe(true);
  expect(JSON.stringify(facts)).not.toContain("private-viewer");
});

test("补齐剧名期间换号，原用户展示不会回传或采集到新账号", async () => {
  const { reporter, reportEvent } = reporterHarness();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  let resolve!: (value: typeof drama) => void;
  const context = new Promise<typeof drama>(done => { resolve = done; });
  reporter.captureRewardedAd(drama.id, "RewardedVideoAd", "entry_reward", context)();
  reporter.identify("other-viewer", "mini", "App");
  resolve(drama);
  await context;
  expect(reportEvent).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "ad_event_identity_changed" }));
});

test("慢目录失败或返回其他剧目不伪填剧名，仍保留已发生的展示并记录诊断", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const context of [Promise.resolve({ ...drama, id: "other" }), Promise.reject(new Error("catalog failed token=private-value"))]) {
    const { reporter, reportEvent } = reporterHarness();
    reporter.captureRewardedAd(drama.id, "RewardedVideoAd", "entry_reward", context)();
    await context.catch(() => undefined);
    expect(reportEvent).toHaveBeenCalledOnce();
    const event = reportEvent.mock.calls[0][0];
    expect(event.params.minis_drama_id).toBe(drama.id);
    expect(event.params).not.toHaveProperty("minis_drama_name");
  }
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "ad_drama_context_failed", error: "catalog failed token=[REDACTED]" }));
});
