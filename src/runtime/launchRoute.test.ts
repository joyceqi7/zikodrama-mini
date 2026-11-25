import { afterEach, expect, it } from "vitest";

import { applyCampaignPreview, hasPlaybackLaunch, readCampaignCover } from "./launchRoute";

afterEach(() => window.history.replaceState({}, "", "/"));

it.each(["campaignCode", "campaign_code", "campaign", "dramaId", "drama_id", "albumId", "album_id", "episodeId", "episode_id"])("根入口识别 %s，投放和剧集均进入播放加载流程", key => {
  expect(hasPlaybackLaunch("", `?${key}=9007199254740993`)).toBe(true);
  expect(hasPlaybackLaunch("#/", `?${key}=9007199254740993`)).toBe(true);
});

it.each(["?campaignCode=", "?campaignCode=%20%20", "?ttclid=click-1&utm_campaign=campaign-1", ""])("空目标或仅归因参数 %s 继续按普通首页启动", search => {
  expect(hasPlaybackLaunch("", search)).toBe(false);
});

it("用户已经选择其他路由时，遗留投放参数不能覆盖当前页面", () => {
  expect(hasPlaybackLaunch("#/profile", "?campaignCode=campaign-1")).toBe(false);
  expect(hasPlaybackLaunch("#/watch/drama-1/episode-1", "")).toBe(true);
});

it("预览只补充投放码，保留二维码入口的其他参数、路由和历史状态", () => {
  window.history.replaceState({ saved: true }, "", "/?locale=en#/");
  applyCampaignPreview("campaign-preview");
  expect(window.location.search).toBe("?locale=en&campaignCode=campaign-preview");
  expect(window.location.hash).toBe("#/");
  expect(window.history.state).toEqual({ saved: true });
  applyCampaignPreview("another-campaign");
  expect(window.location.search).toBe("?locale=en&campaignCode=campaign-preview");
});

it.each(["/?campaign_code=real-campaign", "/?albumId=album-1", "/?ttclid=real-click", "/#/watch/drama/episode", "/#/profile", "/#/privacy"])("预览不改写真实入口 %s", path => {
  window.history.replaceState({}, "", path);
  const originalURL = window.location.href;
  applyCampaignPreview("campaign-preview");
  expect(window.location.href).toBe(originalURL);
});

it("二维码预览沿用深链封面提示，目标标识保持字符串", () => {
  applyCampaignPreview("campaign-preview", new URLSearchParams({
    coverDramaId: "9007199254740993", coverEpisodeId: "18426", coverKey: "covers/main.jpg",
    coverTitle: "Vengeance Of The Duke", coverEpisodeNumber: "1", coverEpisodeCount: "20",
    platformDramaId: "official-drama", platformEpisodeId: "official-episode", episodeId: "ignored",
  }).toString());
  expect(readCampaignCover("", window.location.search)).toEqual({
    dramaId: "9007199254740993", episodeId: "18426", url: "https://img.zikodrama-tv.com/covers/main.jpg",
    title: "Vengeance Of The Duke", episodeNumber: "1", episodeCount: "20",
  });
  expect(readCampaignCover("#/profile", window.location.search)).toBeUndefined();
  const params = new URLSearchParams(window.location.search);
  expect(params.get("platformDramaId")).toBe("official-drama");
  expect(params.get("platformEpisodeId")).toBe("official-episode");
  expect(params.has("episodeId")).toBe(false);
  params.set("coverEpisodeCount", "0");
  expect(readCampaignCover("", params.toString())?.episodeCount).toBeUndefined();
});

it.each(["https://other.example/a.jpg", "/covers/main.jpg", "../main.jpg", "covers/../main.jpg", "covers/main.jpg?token=x", "covers//main.jpg"])("深链拒绝非公开 CDN 相对路径 %s", coverKey => {
  const query = new URLSearchParams({ campaignCode: "campaign-preview", coverDramaId: "663", coverEpisodeId: "18426", coverKey });
  expect(readCampaignCover("", query.toString())).toBeUndefined();
});
