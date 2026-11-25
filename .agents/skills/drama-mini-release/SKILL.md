---
name: drama-mini-release
description: Prepare or review drama-mini build, environment, localization, media-readiness, deployment, and release configuration. Use for release-readiness and runtime-configuration work; it does not authorize deployment or publishing.
---

# Drama Mini Release

This skill provides release knowledge, not permission to deploy, publish, or write to production systems.

## References

- Read [部署运行配置](../../../docs/deployment-runtime-config.md) for environment and runtime configuration.
- Read [单语言发布清单](../../../docs/single-language-release-checklist.md) for locale and copy release checks.
- Read [海外媒资就绪说明](../../../docs/volcengine-overseas-media-readiness.md) for media readiness.
- Read the verification boundary in [TikTok Minis 官方 Player 接入](../../../docs/tiktok-minis-official-player.md) when a release touches playback.

Read each relevant reference completely. Confirm current configuration and official platform requirements instead of treating dated evidence as live state. Never expose or copy secrets, tokens, local environment files, build artifacts, or Git metadata.

Before reporting readiness, run the project `verify` command from `.factory/project.yaml` and state any skipped device, platform, signing, deployment, or production checks.
