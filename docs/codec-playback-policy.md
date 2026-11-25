# 官方 Player 编码策略边界

更新日期：2026-09-03

本项目不再由 H5 选择 DirectUrl、HLS、H.264 或 H.265 播放分支。内容转码、清晰度与兼容输出由 BytePlus VOD 工作流和 TikTok 官方 Player 负责；H5 只提交审核通过的 `albumId`、`episodeId`、`vid` 及旧版客户端需要的短期 `playAuthToken`。

因此客户端禁止实现以下逻辑：

- 按编码格式切换 URL；
- 原生 HTML Video 或第三方播放器回退；
- 自行拼接 BytePlus 播放地址；
- 在浏览器持久化播放 Token。

当前生产合同和验收边界见 [TikTok Minis 官方 Player 接入](./tiktok-minis-official-player.md)。
