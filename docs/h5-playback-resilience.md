# 官方 Player 播放恢复策略

更新日期：2026-09-03

本文档原先描述的 DirectUrl、私有加密 HLS 列表和自带 VePlayer 方案已经废弃。当前生产播放合同以 [TikTok Minis 官方 Player 接入](./tiktok-minis-official-player.md) 为准。

## 当前恢复边界

- 生产只通过 `TTMinis.getPlayer("byteplus")` 获取官方 Player；不创建 HTML `<video>`，也不增加第三方播放器回退。
- 服务端先完成内容状态和权益校验，再返回审核通过的 `albumId`、`episodeId`、`vid`；TikTok 44.5.0 以下客户端按需返回短期 `playAuthToken`。
- 切集复用同一个官方 Player 并调用 `playNext`。失败时保留过渡封面，向用户展示本地化友好提示；不切换为另一种播放协议。
- 浏览器 Mock 仅在 `import.meta.env.DEV` 使用，不能进入生产包。
- 日志只记录业务标识、阶段、结果和耗时，不记录 Token、媒体 URL、Cookie 或签名。

真实恢复能力必须在 TikTok 设备预览中覆盖首次播放、切集、弱网、旧版 Token和销毁重建场景。
