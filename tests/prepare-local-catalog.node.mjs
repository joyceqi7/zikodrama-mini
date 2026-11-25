import assert from "node:assert/strict";
import test from "node:test";

import {
  DERIVATIVE_FIXTURES,
  assertSourceReady,
  buildDramaInput,
  buildEpisodeInput,
  findExistingDerivativeDrama,
  sourceEpisodesForFixture,
  stableMediaIdempotencyKey,
} from "../scripts/prepare-local-catalog.mjs";

test("every derivative is an honest full-series clone", () => {
  const source = Array.from({ length: 70 }, (_, index) => ({
    id: `source-${index + 1}`,
    number: index + 1,
    vid: String(9_000_000_000_000_000n + BigInt(index)),
    mediaStatus: "ready",
  }));

  const expectedEpisodes = Array.from({ length: 70 }, (_, index) => index + 1);
  for (const fixture of DERIVATIVE_FIXTURES) {
    const selected = sourceEpisodesForFixture(source, fixture).map(
      (episode) => episode.number,
    );

    assert.deepEqual(selected, expectedEpisodes);
    assert.match(fixture.copy.title, /^【.+测试.*】日薪一万，我在博物馆值夜班$/);
    assert.equal(
      fixture.copy.description,
      "林修入职博物馆夜班保安后，意外唤醒修复古物的神秘力量，并开始守护城市。",
    );
    assert.deepEqual(fixture.tagIDs, ["37", "21", "40"]);
  }
});

test("drama input uses only fixed TikTok tag IDs", () => {
  const sourceEpisode = { number: 1, posterUrl: "https://img.example.test/1.jpg", durationSeconds: 60 };
  const input = buildDramaInput(
    { title: "Single title", description: "Single description" },
    "completed",
    [sourceEpisode],
    ["37", "21", "40"],
  );

  assert.deepEqual(input.tagIds, ["37", "21", "40"]);
  assert.equal("contentTagIds" in input, false);
  assert.equal("tags" in input, false);
  assert.equal("translations" in input, false);
});

test("derivative upsert reuses the legacy drama instead of creating duplicates", () => {
  const fixture = DERIVATIVE_FIXTURES[0];
  const legacy = { id: "legacy-drama", title: fixture.legacyTitles[0] };

  assert.equal(findExistingDerivativeDrama([legacy], fixture), legacy);
  assert.equal(
    findExistingDerivativeDrama(
      [{ id: "current-drama", title: fixture.copy.title }],
      fixture,
    ).id,
    "current-drama",
  );
});

test("episode input preserves a single deterministic copy", () => {
  const source = {
    id: "7637420375425239060",
    number: 25,
    vid: "7637420375425239061",
    posterUrl: "https://img.example.test/25.jpg",
    durationSeconds: 91,
    mediaStatus: "ready",
  };

  const input = buildEpisodeInput(source, 1, "", "https://img.example.test/cover.jpg");

  assert.equal(input.number, 1);
  assert.equal(input.title, "第1集");
  assert.equal("translations" in input, false);
  assert.equal(input.posterUrl, source.posterUrl);
  assert.equal(input.durationSeconds, 91);
  assert.equal(typeof source.id, "string");
  assert.equal(typeof source.vid, "string");
});

test("episode input falls back to the drama cover when VOD has no poster", () => {
  const input = buildEpisodeInput(
    { number: 1, posterUrl: "", durationSeconds: 0 },
    1,
    "episode-1",
    "https://img.example.test/cover.jpg",
  );

  assert.equal(input.id, "episode-1");
  assert.equal(input.posterUrl, "https://img.example.test/cover.jpg");
});

test("media idempotency key is stable and satisfies the API contract", () => {
  const first = stableMediaIdempotencyKey(
    "drama_7637420375425239060",
    "episode_7637420375425239061",
    "v181b1gm0058d9g6knatgd6fanklsrq0",
  );
  const second = stableMediaIdempotencyKey(
    "drama_7637420375425239060",
    "episode_7637420375425239061",
    "v181b1gm0058d9g6knatgd6fanklsrq0",
  );

  assert.equal(first, second);
  assert.match(first, /^fixture-media-[a-f0-9]+$/);
  assert.ok(first.length >= 16 && first.length <= 128);
});

test("source readiness rejects missing and duplicate media", () => {
  const ready = Array.from({ length: 70 }, (_, index) => ({
    id: `episode-${index + 1}`,
    number: index + 1,
    vid: `vid-${index + 1}`,
    mediaStatus: "ready",
  }));

  assert.doesNotThrow(() => assertSourceReady({ episodes: ready }, 70));
  assert.throws(
    () => assertSourceReady({ episodes: ready.slice(0, 69) }, 70),
    /exactly 70 episodes/,
  );
  assert.throws(
    () => assertSourceReady({ episodes: ready.map((episode, index) => index === 4 ? { ...episode, vid: "" } : episode) }, 70),
    /ready VID/,
  );
  assert.throws(
    () => assertSourceReady({ episodes: ready.map((episode, index) => index === 4 ? { ...episode, vid: "vid-1" } : episode) }, 70),
    /unique VID/,
  );
});
