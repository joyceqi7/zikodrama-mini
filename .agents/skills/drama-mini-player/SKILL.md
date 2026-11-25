---
name: drama-mini-player
description: Implement, diagnose, or review TikTok Minis VePlayer playback in drama-mini, including initialization, playNext episode switching, preload/cache behavior, first-frame covers, progress restore, playback gestures, ads returning to playback, and player events. Use only for playback-facing work in this repository.
---

# Drama Mini Player

Use TikTok Minis' official VePlayer as the only production playback path. Do not add native HTML video, third-party players, direct media URLs, or another VePlayer package.

## Mandatory playback-flow approval gate

For every playback-page or player behavior task in `drama-mini`, read [播放页状态流程](../../../docs/player-state-flow.md) before proposing or changing behavior. This applies to additions, deletions, and modifications in player code, theater UI, styles, event handling, tests, or playback-related configuration.

- Diagnose and inspect read-only when useful, then map the requested change to the flow's startup, parallel loading indicator, local progress restore, ready/seek, confirmed normal playback, progress, pause/resume, and buffering states.
- Before any playback-related mutation, present the exact proposed behavior and affected files/scope, explain whether it preserves or intentionally changes the fixed flow, and wait for explicit user approval. A bug report, request to investigate, or request for a diagram is not approval to edit playback behavior.
- After approval, change only the approved scope. If implementation requires an unapproved behavior or scope change, stop and request approval for the revised proposal.
- Verify the affected branches against the flow after changes. Do not claim platform timing is verified unless tested on the actual TikTok device runtime.
- This gate does not require approval for read-only inspection or explanation. It does require approval before adding, removing, or changing any playback behavior or its verification artifacts.

## Read the relevant references

- For every playback-page or player behavior task, first read [播放页状态流程](../../../docs/player-state-flow.md).

- For any player API or integration change, first read [TikTok Minis 官方 Player 接入](../../../docs/tiktok-minis-official-player.md).
- For API signatures, lifecycle, events, preload/cache, subtitles, HLS, or performance work, also read [官方播放器 API 核对](../../../docs/official-player-api-review-2026-09-20.md).
- For black frame, poster removal, or first-frame timing, read [Web 首帧零黑屏](../../../docs/web-zero-black-first-frame.md).
- For retry, failure, lifecycle resume, or fallback behavior, read [H5 播放恢复策略](../../../docs/h5-playback-resilience.md).
- For codec or packaging decisions, read [播放编码策略](../../../docs/codec-playback-policy.md).
- For startup/loading work, read [Mini 加载实现](../../../docs/mini-loading-implementation-2026-09-20.md).
- For theater interaction, dialogs, selector, ads, progress, and episode-flow changes, read [播放观看流程优化方案](../../../docs/player-viewing-flow-optimization-plan-2026-09-20.md).

Read each selected reference completely before editing. Treat dated plans and verification records as evidence, not automatically as current requirements; verify the present code and current official documentation when behavior or API contracts may have changed.

## Invariants

- Obtain and cache the constructor through `TTMinis.getPlayer("byteplus")` after Minis initialization.
- Keep one stable player instance and container per theater page. Switch episodes with the documented one-argument `playNext(options)` call; do not pause or rebuild merely to switch.
- Treat `albumId`, `episodeId`, and `vid` as strings and only use server-authorized playback descriptors.
- Separate `READY`, `PLAY`, `PLAYING`, `TIME_UPDATE`, `PLAY_NEXT_START`, `PLAY_NEXT_END`, `PRELOAD_INFO`, and actual rendered-frame evidence. Do not call `LOAD_START` a first frame.
- For Feed playback, preserve ordered authorized candidates, `enableMp4MSE`, media-info memory cache, and official preload-scene semantics. A configured preload is not a proven hit; inspect `preLoadData`/`PRELOAD_INFO`.
- Never record tokens, media URLs, cookies, signatures, or raw sensitive SDK objects.

After code changes, run focused player tests, then the project `verify` command from `.factory/project.yaml`. Real TikTok iOS/Android behavior remains a device acceptance item when it cannot be reproduced locally.
