---
name: drama-mini-product-policy
description: Evaluate or implement drama-mini product decisions involving growth, monetization, ads, subscriptions, subtitles, content compliance, and their cross-project contracts. Use when these policy-sensitive product flows are in scope.
---

# Drama Mini Product Policy

Read [增长、合规与字幕决策图](../../../docs/decision-maps/2026-07-14-growth-compliance-subtitles.md) completely before changing a covered flow.

Treat the decision map as project context and dated evidence. Re-check current platform rules when a requirement may have changed, and distinguish official requirements from previous implementation choices. Preserve the user's requested product behavior unless it conflicts with a verified platform requirement.

When an API contract changes, inspect consumers in `drama-mini`, `drama-server`, and `drama-admin`. Do not introduce new persistent business state in Redis or bypass server-side entitlement and idempotency checks. Run focused tests followed by each affected project's declared verification command.
