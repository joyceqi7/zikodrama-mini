import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";


const PRIMARY_COPY = {
    title: "日薪一万，我在博物馆值夜班",
    description:
      "林修入职博物馆夜班保安后，意外唤醒修复古物的神秘力量，并开始守护城市。",
  };

function testCopy(prefix) { return { title: `${prefix}${PRIMARY_COPY.title}`, description: PRIMARY_COPY.description }; }

const ALL_SOURCE_TAG_IDS = ["37", "21", "40"];

export const DERIVATIVE_FIXTURES = [
  {
    key: "ongoing-test-copy",
    legacyTitles: ["博物馆夜班守则", "日薪一万，我在博物馆值夜班（连载测试副本）"],
    sourceStart: 1,
    sourceEnd: 70,
    status: "updating",
    tagIDs: ALL_SOURCE_TAG_IDS,
    copy: testCopy("【连载测试】"),
  },
  {
    key: "completed-test-copy-a",
    legacyTitles: ["夜班保安的超能力", "日薪一万，我在博物馆值夜班（完结测试副本 A）"],
    sourceStart: 1,
    sourceEnd: 70,
    status: "completed",
    tagIDs: ALL_SOURCE_TAG_IDS,
    copy: testCopy("【完结测试 A】"),
  },
  {
    key: "completed-test-copy-b",
    legacyTitles: ["都市守夜人", "日薪一万，我在博物馆值夜班（完结测试副本 B）"],
    sourceStart: 1,
    sourceEnd: 70,
    status: "completed",
    tagIDs: ALL_SOURCE_TAG_IDS,
    copy: testCopy("【完结测试 B】"),
  },
];


const EPISODE_COPY = (number) => ({ title: `第${number}集`, description: `第${number}集剧情` });

export function sourceEpisodesForFixture(episodes, fixture) {
  return [...episodes]
    .sort((left, right) => left.number - right.number)
    .filter(
      (episode) =>
        episode.number >= fixture.sourceStart &&
        episode.number <= fixture.sourceEnd,
    );
}

export function buildEpisodeInput(
  sourceEpisode,
  number,
  existingID = "",
  fallbackPosterURL = "",
) {
  const copy = EPISODE_COPY(number);
  return {
    ...(existingID ? { id: String(existingID) } : {}),
    number,
    title: copy.title,
    description: copy.description,
    posterUrl: sourceEpisode.posterUrl || fallbackPosterURL,
    durationSeconds: Math.max(0, Number(sourceEpisode.durationSeconds) || 0),
  };
}

export function stableMediaIdempotencyKey(dramaID, episodeID, vid) {
  const digest = createHash("sha256")
    .update(`${String(dramaID)}\0${String(episodeID)}\0${String(vid)}`)
    .digest("hex");
  return `fixture-media-${digest}`;
}

export function assertSourceReady(drama, expectedCount = 70) {
  if (!Array.isArray(drama?.episodes) || drama.episodes.length !== expectedCount) {
    throw new Error(`Source drama must contain exactly ${expectedCount} episodes`);
  }
  const ordered = [...drama.episodes].sort((left, right) => left.number - right.number);
  ordered.forEach((episode, index) => {
    if (episode.number !== index + 1) {
      throw new Error(`Source drama episode numbering must be contiguous at ${index + 1}`);
    }
    if (episode.mediaStatus !== "ready" || !String(episode.vid || "").trim()) {
      throw new Error(`Source episode ${episode.number} does not have a ready VID`);
    }
  });
  const vids = ordered.map((episode) => String(episode.vid));
  if (new Set(vids).size !== vids.length) {
    throw new Error("Source drama episodes must each have a unique VID");
  }
}

export function findExistingDerivativeDrama(dramas, fixture) {
  const acceptedTitles = new Set([
    fixture.copy.title,
    ...(fixture.legacyTitles || []),
  ]);
  return dramas.find(
    (drama) =>
      acceptedTitles.has(drama.title)
  );
}

class OperationsClient {
  constructor(baseURL) {
    this.baseURL = baseURL.replace(/\/$/, "");
    this.token = "";
    this.applicationID = "";
  }

  async login(username, password) {
    const session = await this.request(
      "/admin/v1/session",
      { method: "POST", body: JSON.stringify({ username, password }) },
      false,
    );
    this.token = String(session.token);
    return session;
  }

  async request(path, init = {}, authenticate = true) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (authenticate) {
      headers.set("authorization", `Bearer ${this.token}`);
      if (this.applicationID) headers.set("x-application-id", this.applicationID);
    }
    const response = await fetch(`${this.baseURL}${path}`, { ...init, headers });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${init.method || "GET"} ${path} returned HTTP ${response.status} without JSON`);
    }
    if (!response.ok || payload.error) {
      const code = payload.error?.code ? ` (${payload.error.code})` : "";
      throw new Error(`${init.method || "GET"} ${path} failed${code}: ${payload.error?.message || response.status}`);
    }
    return payload.data;
  }
}

export function buildDramaInput(copy, status, sourceEpisodes, tagIDs, existing) {
  const existingByNumber = new Map(
    (existing?.episodes || []).map((episode) => [episode.number, episode]),
  );
  const coverURL = existing?.coverUrl || sourceEpisodes.find((episode) => episode.posterUrl)?.posterUrl || "";
  return {
    title: copy.title,
    description: copy.description,
    coverUrl: coverURL,
    status,
    year: 2026,
    language: "zh",
    dramaType: 4,
    tagIds: tagIDs.map(String),
    episodes: sourceEpisodes.map((sourceEpisode, index) =>
      buildEpisodeInput(
        sourceEpisode,
        index + 1,
        existingByNumber.get(index + 1)?.id,
        coverURL,
      ),
    ),
  };
}

async function unpublishIfNeeded(client, drama) {
  if (drama.publishStatus !== "published") return drama;
  return client.request(`/admin/v1/dramas/${encodeURIComponent(drama.id)}/unpublish`, {
    method: "POST",
    body: "{}",
  });
}

async function saveDrama(client, input, existing) {
  if (!existing) {
    return client.request("/admin/v1/dramas", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  await unpublishIfNeeded(client, existing);
  return client.request(`/admin/v1/dramas/${encodeURIComponent(existing.id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

async function publishDrama(client, drama) {
  if (drama.publishStatus === "published") return drama;
  return client.request(`/admin/v1/dramas/${encodeURIComponent(drama.id)}/publish`, {
    method: "POST",
    body: "{}",
  });
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

async function attachExistingMedia(client, target, sourceEpisodes, sourceJobs) {
  const sourceByTargetNumber = new Map(
    sourceEpisodes.map((episode, index) => [index + 1, episode]),
  );
  const pending = target.episodes.filter((episode) => {
    const source = sourceByTargetNumber.get(episode.number);
    return source && (episode.mediaStatus !== "ready" || episode.vid !== source.vid);
  });
  if (pending.length === 0) return target;

  await runWithConcurrency(pending, 5, async (episode) => {
    const source = sourceByTargetNumber.get(episode.number);
    const sourceJob = sourceJobs.get(source.id);
    await client.request(`/admin/v1/episodes/${encodeURIComponent(episode.id)}/media/direct`, {
      method: "POST",
      headers: {
        "idempotency-key": stableMediaIdempotencyKey(target.id, episode.id, source.vid),
      },
      body: JSON.stringify({
        vid: String(source.vid),
        uploadRequestId: `fixture-reuse-${String(source.id)}`,
        fileName: sourceJob?.fileName || `source-${source.number}.mp4`,
        size: Math.max(1, Number(sourceJob?.size) || 1),
      }),
    });
  });

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const [fresh, jobs] = await Promise.all([
      client.request(`/admin/v1/dramas/${encodeURIComponent(target.id)}`),
      client.request(`/admin/v1/dramas/${encodeURIComponent(target.id)}/media-jobs`),
    ]);
    const failed = jobs.find((job) => job.status === "failed");
    if (failed) {
      throw new Error(`Media reuse failed for ${failed.fileName}: ${failed.error || failed.jobId}`);
    }
    const complete = fresh.episodes.every((episode) => {
      const source = sourceByTargetNumber.get(episode.number);
      return source && episode.mediaStatus === "ready" && episode.vid === source.vid;
    });
    if (complete) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out while attaching media to ${target.title}`);
}

async function configureApplicationMonetization(client, application) {
  const episodeAdUnitCode = process.env.DRAMA_LOCAL_EPISODE_AD_UNIT_CODE || "demo-episode-reward";
  const vipAdUnitCode = process.env.DRAMA_LOCAL_VIP_AD_UNIT_CODE || "demo-vip-reward";
  const rewardedVideo = [...new Set([
    ...(application.adUnits?.rewardedVideo || []),
    episodeAdUnitCode,
    vipAdUnitCode,
  ])];

  // 广告位只是应用登记的编码。先整体更新应用编码集合，再让变现配置直接引用编码；
  // 不创建广告位实体，也不依赖名称、状态或单独的广告位管理接口。
  await client.request(`/admin/v1/applications/${encodeURIComponent(application.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      code: application.code,
      name: application.name,
      logoUrl: application.logoUrl || "",
      tiktokAppId: application.tiktokAppId || "",
      clientKey: application.clientKey || "",
      secretRef: application.secretRef || "",
      launchUrl: application.launchUrl || "",
      regionCode: application.regionCode,
      timeZone: application.timeZone,
      complianceBaseUrl: application.complianceBaseUrl || "",
      monetizationMode: application.monetizationMode,
      status: application.status,
      adUnits: {
        rewardedVideo,
        interstitial: application.adUnits?.interstitial || [],
      },
    }),
  });

  return client.request("/admin/v1/application-monetization", {
    method: "PUT",
    body: JSON.stringify({
      freeEpisodeCount: 3,
      episodeUnlockAdUnitCode: episodeAdUnitCode,
      vipStrategy: {
        enabled: true,
        forceWatchCount: 3,
        requiredAdCount: 5,
        delaySeconds: 0,
        adUnitCode: vipAdUnitCode,
        title: "今日 VIP",
        content: "先完整观看 3 个广告继续访问，累计 5 个广告获得今日 VIP。",
        failureMessage: "",
      },
    }),
  });
}

async function main() {
  const baseURL = process.env.DRAMA_API_BASE_URL || "http://localhost:18081";
  const username = process.env.DRAMA_ADMIN_USERNAME || "admin";
  const password = process.env.DRAMA_ADMIN_PASSWORD || "";
  const sourceDramaID = process.env.DRAMA_SOURCE_DRAMA_ID || "";
  const applicationCode = String(process.env.DRAMA_APPLICATION_CODE || "").trim();
  if (!applicationCode) throw new Error("DRAMA_APPLICATION_CODE is required");
  if (!password) throw new Error("DRAMA_ADMIN_PASSWORD is required");
  if (!sourceDramaID) throw new Error("DRAMA_SOURCE_DRAMA_ID is required");

  const client = new OperationsClient(baseURL);
  await client.login(username, password);
  const applications = await client.request("/admin/v1/applications");
  const application = applications.find((item) => item.code === applicationCode && item.status === "active");
  if (!application) throw new Error(`Active application not found: ${applicationCode}`);
  client.applicationID = String(application.id);

  let source = await client.request(`/admin/v1/dramas/${encodeURIComponent(sourceDramaID)}`);
  assertSourceReady(source);

  const primaryTagIDs = [...ALL_SOURCE_TAG_IDS];
  const primaryInput = buildDramaInput(
    PRIMARY_COPY,
    "completed",
    [...source.episodes].sort((left, right) => left.number - right.number),
    primaryTagIDs,
    source,
  );
  primaryInput.coverUrl = source.coverUrl;
  source = await saveDrama(client, primaryInput, source);
  source = await publishDrama(client, source);

  const sourceJobs = new Map(
    (await client.request(`/admin/v1/dramas/${encodeURIComponent(source.id)}/media-jobs`))
      .map((job) => [job.episodeId, job]),
  );
  let currentDramas = await client.request("/admin/v1/dramas");
  const results = [source];
  for (const fixture of DERIVATIVE_FIXTURES) {
    const sourceEpisodes = sourceEpisodesForFixture(source.episodes, fixture);
    const existing = findExistingDerivativeDrama(currentDramas, fixture);
    const input = buildDramaInput(
      fixture.copy,
      fixture.status,
      sourceEpisodes,
      fixture.tagIDs,
      existing,
    );
    input.coverUrl = source.coverUrl;
    let target = await saveDrama(client, input, existing);
    target = await attachExistingMedia(client, target, sourceEpisodes, sourceJobs);
    target = await publishDrama(client, target);
    results.push(target);
    currentDramas = currentDramas.filter((drama) => drama.id !== target.id).concat(target);
  }

  await configureApplicationMonetization(client, application);
  const summary = results.map((drama) => ({
    id: String(drama.id),
    title: drama.title,
    episodes: drama.episodes.length,
    publishStatus: drama.publishStatus,
  }));
  process.stdout.write(`${JSON.stringify({ application: application.code, dramas: summary }, null, 2)}\n`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
