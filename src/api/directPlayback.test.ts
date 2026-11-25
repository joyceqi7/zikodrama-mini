import { expect, it, vi } from "vitest";
import { HttpMiniDramaApi } from "./httpMiniDramaApi";
const response = (data: unknown) => new Response(JSON.stringify({ serverTime: new Date().toISOString(), data }));
const bootstrap = {
  applicationId: "101",
  visitorId: "1",
  visitorToken: "test",
  tiktokAppId: "test-app",
  playbackSdk: {
    provider: "byteplus_web",
    channel: "byteplus",
    capabilities: { mediaPreload: false },
  },
};
const play = () => ({
  status: "playable",
  drama: { id: "201" },
  episode: { id: "301" },
  playback: {
    channel: "byteplus",
    vid: "direct-vid",
    playAuthToken: "test-only-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
});
it("新增字段兼容原播放路由，批量与领奖恢复均按应用 provider 校验", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(bootstrap))
    .mockResolvedValueOnce(response(play()))
    .mockResolvedValueOnce(response([play()]))
    .mockResolvedValueOnce(
      response({
        claimId: "claim",
        status: "granted",
        unlocked: true,
        dramaId: "201",
        episodeId: "301",
        rewardType: "episode_unlock",
        playback: play(),
      }),
    );
  const api = new HttpMiniDramaApi("https://api.example", fetcher);
  await api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} });
  await expect(api.resolvePlay("201", "301")).resolves.toMatchObject({
    playback: { provider: "byteplus_web" },
  });
  await expect(api.resolvePlayBatch("201", ["301"])).resolves.toMatchObject([
    { playback: { provider: "byteplus_web" } },
  ]);
  await expect(
    api.claimReward({
      claimId: "claim",
      offerId: "offer",
      adUnitId: "ad",
      dramaId: "201",
      episodeId: "301",
    }),
  ).resolves.toMatchObject({
    playback: { playback: { provider: "byteplus_web" } },
  });
  expect(fetcher.mock.calls[1][0]).toContain("/api/v1/");
  expect(
    fetcher.mock.calls.every(
      (c) => !new Headers(c[1]?.headers).has("X-Mini-Contract"),
    ),
  ).toBe(true);
});
it("锁定集不接收 Token，过期及混用官方字段的直连结果均拒绝", async () => {
  const malformed = [
    { ...play(), status: "access_required" },
    {
      ...play(),
      playback: { ...play().playback, expiresAt: new Date(0).toISOString() },
    },
    { ...play(), playback: { ...play().playback, albumId: "wrong" } },
  ];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response(bootstrap));
  for (const p of malformed) fetcher.mockResolvedValueOnce(response(p));
  const api = new HttpMiniDramaApi("https://api.example", fetcher);
  await api.bootstrap({ tiktokAppId: "test-app", launchQuery: {} });
  for (const _ of malformed)
    await expect(api.resolvePlay("201", "301")).rejects.toMatchObject({
      code: "invalid_response",
    });
});

it("同一应用和观众重新启动后按新模式解析播放，往返切换不沿用旧合同", async () => {
  const official = { ...bootstrap, playbackSdk: { provider: "tiktok_minis", channel: "byteplus" } };
  const officialPlay = { ...play(), playback: { channel: "byteplus", albumId: "official-album", episodeId: "official-episode", vid: "official-vid" } };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response(official))
    .mockResolvedValueOnce(response(officialPlay))
    .mockResolvedValueOnce(response(bootstrap))
    .mockResolvedValueOnce(response(play()))
    .mockResolvedValueOnce(response(official))
    .mockResolvedValueOnce(response(officialPlay));
  const api = new HttpMiniDramaApi("https://api.example", fetcher);
  const input = { tiktokAppId: "test-app", launchQuery: {} };
  for (const provider of ["tiktok_minis", "byteplus_web", "tiktok_minis"]) {
    await expect(api.bootstrap(input)).resolves.toMatchObject({ applicationId: "101", visitorId: "1" });
    await expect(api.resolvePlay("201", "301")).resolves.toMatchObject({ playback: { provider } });
  }
});

it("目录和详情只读取当前上线内容，连载换版后播放新集无需客户端版本参数", async () => {
 const oldDetail={id:"201",title:"连载第一批",episodes:[{id:"301",number:1,title:"第一集",accessMode:"free"}]};
 const nextDetail={...oldDetail,title:"连载第二批",episodes:[...oldDetail.episodes,{id:"302",number:2,title:"第二集",accessMode:"free"}]};
 const fetcher=vi.fn<typeof fetch>()
  .mockResolvedValueOnce(response(bootstrap))
  .mockResolvedValueOnce(response({tiktokAppId:"test-app",dramas:[{id:"201",title:oldDetail.title}]}))
  .mockResolvedValueOnce(response(oldDetail))
  .mockResolvedValueOnce(response(nextDetail))
  .mockResolvedValueOnce(response({...play(),episode:{id:"302"},playback:{...play().playback,vid:"new-episode-vid"}}));
 const api=new HttpMiniDramaApi("https://api.example",fetcher);
 await api.bootstrap({tiktokAppId:"test-app",launchQuery:{}});
 const catalog=await api.publicCatalog("test-app");
 expect(catalog.dramas[0].title).toBe(oldDetail.title);
 const first=await api.drama("201");
 expect(first.episodes).toHaveLength(1);
 const updated=await api.drama("201");
 expect(updated.title).toBe(nextDetail.title);
 expect(updated.episodes).toHaveLength(2);
 expect(updated).not.toHaveProperty("contentVersion");
 expect(updated).not.toHaveProperty("contentVersionId");
 await expect(api.resolvePlay("201",updated.episodes[1].id)).resolves.toMatchObject({episode:{id:"302"},playback:{vid:"new-episode-vid",provider:"byteplus_web"}});
 for(const [url,init] of fetcher.mock.calls) {
  expect(String(url)).not.toContain("version");
  if(init?.body) expect(JSON.parse(String(init.body))).not.toHaveProperty("versionId");
 }
});
