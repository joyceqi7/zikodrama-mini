import { describe, expect, it, vi } from "vitest";

import { HttpMiniDramaApi } from "./httpMiniDramaApi";

describe("HttpMiniDramaApi", () => {
  it("入剧结算可选状态使用同一服务器时间基准，旧响应缺省仍正常确认", async () => {
    const data = { claimId: "entry-state", status: "granted", rewardType: "entry_progress", unlocked: false, dramaId: "201", episodeId: "" };
    const entryAdStatus = { enabled: true, scope: "user_drama", countBy: "completed", completedCount: 2, requiredCount: 2,
      progressDate: "2026-10-24", validUntil: "2026-10-25T00:00:00Z", offer: { offerId: "entry", adUnitId: "ad", kind: "rewarded_entry" } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: "2026-10-24T23:00:00Z", data: { ...data, entryAdStatus } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data })));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    const claim = { claimId: data.claimId, offerId: "entry", adUnitId: "ad", dramaId: "201" };
    const result = await api.claimReward(claim);
    expect(result.entryAdStatus).toMatchObject({ ...entryAdStatus, serverDeadline: expect.any(Object) });
    await expect(api.claimReward(claim)).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("损坏的新增状态不撤销成功结算，保留旧查询恢复路径", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const data = { claimId: "entry-state", status: "granted", rewardType: "entry_progress", unlocked: false, dramaId: "201", episodeId: "" };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...data, entryAdStatus: { enabled: true, completedCount: -1 }, drama: { id: "201", episodes: [null] } } })));
      const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
      await expect(api.claimReward({ claimId: data.claimId, offerId: "entry", adUnitId: "ad", dramaId: "201" })).resolves.toEqual(data);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it("入剧达标未入库也清除待确认，VIP 和逐集奖励不能使用此状态", async () => {
    const result = { claimId: "entry-cap", status: "entry_satisfied", rewardType: "entry_progress", unlocked: false, dramaId: "201", episodeId: "" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: result })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...result, rewardType: "vip_progress" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...result, rewardType: "episode_unlock", unlocked: true } })));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    const claim = { claimId: "entry-cap", offerId: "entry", adUnitId: "ad", dramaId: "201" };
    await expect(api.claimReward(claim)).resolves.toEqual(result);
    await expect(api.claimReward(claim)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(api.claimReward(claim)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("首页等场景仅传场景查询每日事实，不传剧目、N、模式或奖励 Offer", async () => {
    const status = { shownCount: 2, progressDate: "2026-10-08", validUntil: new Date(Date.now() + 60_000).toISOString() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: new Date().toISOString(), data: status })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: new Date().toISOString(), data: { ...status, shownCount: -1 } })));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    await expect(api.adShowStatus("home_entry")).resolves.toMatchObject(status);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.example.test/api/v1/me/ad-shows?scene=home_entry");
    await expect(api.adShowStatus("entry_reward", "9007199254740993")).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher.mock.calls[1][0]).toContain("dramaId=9007199254740993");
  });
  it("新版入剧确认缺失或故障直接返回错误，不回退旧展示接口", async () => {
    const show = { eventId: "entry-original", scene: "entry_reward", occurredAt: "2026-10-08T09:00:00.000Z", adUnitId: "ad", dramaId: "9007199254740993" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response("", { status: 503 }));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    await expect(api.recordAdShow(show)).rejects.toMatchObject({ status: 404 });
    await expect(api.recordAdShow(show)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => String(call[0]).endsWith("/me/entry-ad/shows"))).toBe(true);
  });
  it("新版入剧请求携带字符串剧目并读取展示事实，未知模式拒绝放行", async () => {
    const status = { enabled: true, scope: "user_drama", countBy: "shown", shownCount: 2, completedCount: 0, requiredCount: 2,
      validUntil: new Date(Date.now()+60_000).toISOString(), offer: { offerId: "entry", adUnitId: "entry-ad", kind: "rewarded_entry" } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: new Date().toISOString(), data: status })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accepted: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: new Date().toISOString(), data: { ...status, countBy: "attempt" } })));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    await expect(api.entryAdStatus("9007199254740993")).resolves.toMatchObject({ shownCount: 2, completedCount: 0 });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.example.test/api/v1/me/entry-ad?dramaId=9007199254740993");
    const show = { eventId: "entry-key", scene: "entry_reward", occurredAt: new Date().toISOString(), dramaId: "9007199254740993", adUnitId: "entry-ad" };
    await expect(api.recordAdShow(show)).resolves.toEqual({ accepted: true });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(show);
    await expect(api.entryAdStatus("9007199254740993")).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("读取当日入剧进度并按来源剧目结算入剧广告", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: new Date().toISOString(), data: { enabled: true, scope: "user", countBy: "completed", completedCount: 1, requiredCount: 2, validUntil: new Date(Date.now() + 60_000).toISOString(), offer: { offerId: "entry-offer", kind: "rewarded_entry", adUnitId: "entry-ad" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { claimId: "entry-claim", status: "granted", unlocked: false, dramaId: "", episodeId: "", rewardType: "entry_progress" } }), { status: 201 }));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    await expect(api.entryAdStatus("201")).resolves.toMatchObject({ completedCount: 1, requiredCount: 2 });
    await expect(api.claimReward({ claimId: "entry-claim", offerId: "entry-offer", adUnitId: "entry-ad", dramaId: "201" })).resolves.toMatchObject({ rewardType: "entry_progress" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.example.test/api/v1/me/entry-ad?dramaId=201");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ dramaId: "201", episodeId: "", isEnded: true });
  });
  it("保留超出安全整数范围的内部 ID，并与带前导零的官方 AppID 分开传递", async () => {
    const identity = {
      applicationId: "9007199254740993",
      visitorId: "18446744073709551615",
      tiktokAppId: "0007685293427067586568",
      visitorToken: "test-only-credential",
      identityState: "tiktok_authenticated",
      appName: "ID 验证",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: identity }), { status: 200 }),
    );
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    const result = await api.bootstrap({ tiktokAppId: identity.tiktokAppId, launchQuery: {} });
    expect(result).toMatchObject(identity);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ tiktokAppId: identity.tiktokAppId, launchQuery: {} });
  });

  it("invokes fetch without rebinding the native function", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              visitorId: "visitor-1",
              applicationId: "application-1", tiktokAppId: "test-app",
              identityState: "anonymous",
              visitorToken: "visitor-1",
              appName: "Drama Minis",
              logoUrl: "https://cdn.example.test/drama-minis.png",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await expect(
			api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} }),
    ).resolves.toMatchObject({
      visitorId: "visitor-1",
      identityState: "anonymous",
      logoUrl: "https://cdn.example.test/drama-minis.png",
    });
  });

  it("adopts the bootstrap token for subsequent requests", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              visitorId: "visitor-1",
              applicationId: "application-1", tiktokAppId: "test-app",
              identityState: "anonymous",
              visitorToken: "visitor-1",
              appName: "Drama Minis",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { dramas: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

		await api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} });
    await api.home();

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.example.com/api/v1/bootstrap");
    const secondRequest = fetcher.mock.calls[1]?.[1];
    expect(new Headers(secondRequest?.headers).get("authorization")).toBe(
      "Bearer visitor-1",
    );
  });

  it("reissues the Visitor credential and retries an unauthorized request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              visitorId: "visitor-1",
              applicationId: "application-1", tiktokAppId: "test-app",
              identityState: "anonymous",
              visitorToken: "visitor-1",
              appName: "Drama Minis",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 500, reason: "unauthorized", message: "expired", data: null,
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              visitorId: "visitor-1",
              applicationId: "application-1", tiktokAppId: "test-app",
              identityState: "tiktok_authenticated",
              visitorToken: "visitor-2",
              appName: "Drama Minis",
              monetization: {
                status: "disabled",
                strategy: "episode_reward",
                freeEpisodeCount: 0,
                episodeReward: { unlockEpisodeCount: 1, dailyRewardLimit: 0 },
                vip: { enabled: false, requiredAdCount: 1, title: "", content: "" },
              },
              vipState: { active: false, adCount: 0, requiredCount: 1, progressDate: "" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { dramas: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);
    const bootstrapInput = vi.fn(async () => ({
			tiktokAppId: "test-app",
      loginCode: "fresh-code",
      launchQuery: {},
    }));
    const bootstrapObserver = vi.fn();
    api.setBootstrapInputProvider(bootstrapInput, bootstrapObserver);

    await api.bootstrap({
			tiktokAppId: "test-app",
      loginCode: "initial-code",
      launchQuery: {},
    });
    await expect(api.home()).resolves.toEqual({ dramas: [] });

    expect(bootstrapInput).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
      visitorToken: "visitor-1",
      loginCode: "fresh-code",
    });
    expect(bootstrapObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        visitorId: "visitor-1",
        identityState: "tiktok_authenticated",
        visitorToken: "visitor-2",
      }),
    );
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer visitor-1");
    expect(
      new Headers(fetcher.mock.calls[3]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer visitor-2");
  });

  it("submits one idempotent reward claim after the configured ad unit completes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            claimId: "claim-episode-0001",
            status: "granted",
            unlocked: true,
            dramaId: "drama-1",
            episodeId: "episode-3",
            rewardType: "episode_unlock",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await api.claimReward({
      claimId: "claim-episode-0001",
      offerId: "offer-episode-1",
      adUnitId: "placement-primary",
      dramaId: "drama-1",
      episodeId: "episode-3",
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/v1/reward-grants",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      claimId: "claim-episode-0001",
      offerId: "offer-episode-1",
      dramaId: "drama-1",
      episodeId: "episode-3",
      completedAdUnitId: "placement-primary",
      isEnded: true,
    });
  });

  it("播放解析只提交业务标识，不携带旧版客户端参数", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { status: "unavailable" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await api.resolvePlay("drama-1", "episode-2");

    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.example.com/api/v1/play/resolve?entryPreview=1");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      dramaId: "drama-1",
      episodeId: "episode-2",
    });
  });

  it("批量解析相邻集并保持输入顺序", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { status: "playable", episode: { id: "2" },playback:{channel:"byteplus",albumId:"album",episodeId:"platform-2",vid:"vid-2"} },
      { status: "access_required", episode: { id: "3" } },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await expect(api.resolvePlayBatch("1", ["2", "3"])).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/play/resolve-batch?entryPreview=1",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ dramaId: "1", episodeIds: ["2", "3"] }) }),
    );
  });

  it("submits a targetless VIP reward claim without an attempt credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            claimId: "claim-vip-00000001",
            status: "granted",
            unlocked: false,
            dramaId: "",
            episodeId: "",
            rewardType: "vip_progress",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await api.claimReward({
      claimId: "claim-vip-00000001",
      offerId: "offer-vip-1",
      adUnitId: "vip-placement",
    });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      claimId: "claim-vip-00000001",
      offerId: "offer-vip-1",
      dramaId: "",
      episodeId: "",
      completedAdUnitId: "vip-placement",
      isEnded: true,
    });
  });

  it("uses only server-authoritative entitlement endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await api.unlocks();

    expect(
      fetcher.mock.calls.map(([url, init]) => [url, init?.method || "GET"]),
    ).toEqual([
      ["https://api.example.com/api/v1/me/unlocks", "GET"],
    ]);
  });

  it("encodes discovery filters and opaque cursor continuation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { items: [], tags: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const api = new HttpMiniDramaApi("https://api.example.com", fetcher);

    await api.discover({
      query: "hidden truth",
      tag: "Mystery & Crime",
      status: "completed",
      cursor: "djE6MjA",
      limit: 12,
    });

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/v1/discovery?query=hidden+truth&tag=Mystery+%26+Crime&status=completed&cursor=djE6MjA&limit=12",
    );
  });
});

it.each(["another-app", undefined])("拒绝错误或缺失的官方 AppID，日志不包含凭据", async (returnedId) => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const api = new HttpMiniDramaApi("", async () => new Response(JSON.stringify({ data: {
      tiktokAppId: returnedId, appCode: "test-app", applicationId: "internal-app", visitorId: "visitor", visitorToken: "private-token",
    } })));
    await expect(api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} })).rejects.toMatchObject({ code: "invalid_response" });
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ event: "bootstrap_identity_rejected", error: expect.stringContaining("identity is invalid") }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private-token");
  } finally { errorLog.mockRestore(); }
});

it("身份安装失败保留实际原因并脱敏日志，失败凭据不投入使用", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const api = new HttpMiniDramaApi("", async () => new Response(JSON.stringify({ data: {
      tiktokAppId: "test-app", applicationId: "app", visitorId: "visitor", visitorToken: "private-token",
    } })));
    const failure = new Error("identity observer unavailable token=private-token");
    const session = vi.fn();
    api.setSessionStateObserver(session);
    api.setBootstrapInputProvider(async () => ({ tiktokAppId: "test-app", launchQuery: {} }), () => { throw failure; });
    await expect(api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} })).rejects.toBe(failure);
    expect(session).toHaveBeenLastCalledWith(false);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ event: "bootstrap_observer_failed", error: "identity observer unavailable token=[REDACTED]" }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private-token");
  } finally { errorLog.mockRestore(); }
});

it.each(["metrics", "ad-errors"] as const)("%s 的 401 不触发静默登录恢复，后续业务仍可独立请求", async endpoint => {
 const fetcher=vi.fn<typeof fetch>()
  .mockResolvedValueOnce(new Response(JSON.stringify({data:{applicationId:'101',visitorId:'201',tiktokAppId:'101',visitorToken:'test-only-token',identityState:'tiktok_authenticated'}})))
  .mockResolvedValueOnce(new Response(JSON.stringify({code:401,reason:'unauthorized',message:'Unauthorized',data:null}),{status:401}))
  .mockResolvedValueOnce(new Response(JSON.stringify({data:{dramas:[]}})));
 const api=new HttpMiniDramaApi('https://api.example.test',fetcher);
 const provider=vi.fn(async()=>({tiktokAppId:'101',launchQuery:{}}));api.setBootstrapInputProvider(provider);
 await api.bootstrap({tiktokAppId:'101',launchQuery:{}});
 const request = endpoint === "metrics" ? api.collectMetrics([{id:'test-metric-12345678',kind:'active',occurredAt:new Date().toISOString()}]) : api.reportAdErrors([{
   id: "ad-error-example-01", ad: {adType: "rewarded", adUnitId: "slot", scene: "entry_reward", clientVersion: "build", os: "ios", tiktokVersion: "unknown", stage: "show", reason: "sdk_error"},
   failure: {error: "SDK failed", errorDocument: "visible", errorNative: "unknown", errorPrerender: false, shown: false, userInitiated: false},
 }]);
 await expect(request).rejects.toMatchObject({status:401});
 expect(fetcher.mock.calls[1][0]).toBe(`https://api.example.test/api/v1/${endpoint}`);
 const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
 expect(body.events).toHaveLength(1);
 expect("failure" in body.events[0]).toBe(endpoint === "ad-errors");
 expect(provider).not.toHaveBeenCalled();
 await expect(api.home()).resolves.toEqual({dramas:[]});
 expect(fetcher).toHaveBeenCalledTimes(3);
});

it("三个首页接口独立校验数组，分类榜拒绝数字标签身份和错误剧目数组", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (const rankings of [[{ tagId: 21, name: "Mystery", dramas: [] }], [{ tagId: "21", name: "Mystery", dramas: null }]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: rankings }), { status: 200 }));
      await expect(new HttpMiniDramaApi("https://api.example.test", fetcher).homeRankings("101")).rejects.toThrow("Homepage rankings are invalid");
    }
    expect(JSON.stringify(log.mock.calls)).toContain("home_rankings_invalid");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const api = new HttpMiniDramaApi("https://api.example.test", fetcher);
    await expect(Promise.all([api.homeCarousel("101"), api.homeHot("101"), api.homeRankings("101")])).resolves.toEqual([[], [], []]);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      "https://api.example.test/api/v1/open/home/carousel?tiktokAppId=101",
      "https://api.example.test/api/v1/open/home/hot?tiktokAppId=101",
      "https://api.example.test/api/v1/open/home/rankings?tiktokAppId=101",
    ]));
  } finally { log.mockRestore(); }
});

it("公开 GET 不携带鉴权或无用 JSON 请求头，避免额外跨域预检", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const api = new HttpMiniDramaApi("https://sandbox.example", fetcher);
  await api.homeCarousel("101");
  const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("content-type")).toBe(false);
});
