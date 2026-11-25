---
name: drama-mini-ui
description: Design, implement, or review drama-mini interfaces and visual behavior, including the Discover page, theater overlays, dialogs, episode selector, spacing, typography, responsive layout, and Plotimo branding. Use for UI work in this repository, not playback-kernel internals.
---

# Drama Mini Ui

Preserve the existing product language and official TikTok short-drama UI boundary. Do not replace working product flows with generic redesigns.

## References

- Read [Plotimo 品牌规范](../../../docs/branding/plotimo-brand.md) for brand, color, typography, and asset decisions.
- Read [设计 QA](../../../design-qa.md) when reviewing or changing an existing screen; verify whether dated findings still reproduce before acting on them.
- For theater dialogs, episode selector, overlays, gestures, or ad-related UI, read [播放观看流程优化方案](../../../docs/player-viewing-flow-optimization-plan-2026-09-20.md) and the UI boundary in [TikTok Minis 官方 Player 接入](../../../docs/tiktok-minis-official-player.md).

Read only the references relevant to the requested surface, but read each selected file completely. Preserve user-approved copy unless the user asks to change it. Reuse official player controls where required and keep business overlays clear of official interactive regions and device safe areas.

For code changes, verify the focused component interactions and responsive states, then run the project `verify` command from `.factory/project.yaml`.
