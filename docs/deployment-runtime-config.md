# H5 部署配置边界

更新日期：2026-09-14

## 构建期

TikTok Minis 包不能在运行时替换应用身份和可信域名。每个 `configs/apps/<tiktokAppId>.json` 固定当前应用，并通过 `deployments.sandbox` 与 `deployments.production` 只切换公开端点：

- 字符串 `tiktokAppId`（TikTok 官方 AppID）、品牌信息和独立的 TikTok Client Key；
- Sandbox/Production API Origin；
- 默认语言与支持语言。

`make package-sandbox APP=<tiktokAppId>` 和 `make package-production APP=<tiktokAppId>` 会拒绝占位符、HTTP、本机地址和缺失的 H5 Origin。BytePlus Space、长期 AK/SK、TikTok Client Secret 与 Access Token 永远不能写入 H5 配置或构建产物。

TikTok Minis 官方 Player 不要求 H5 随包携带 VePlayer License，也不安装独立 VePlayer npm 包。`index.html` 只加载官方 Minis SDK，并以当前包的 Client Key 调用 `TTMinis.init`。

配置文件名必须与 `tiktokAppId` 完全相同，例如 `configs/apps/0009007199254740993123.json`（此值仅作格式示例）。JSON 中始终加引号，不转数字。环境变量模式使用 `VITE_TIKTOK_APP_ID`；Docker 构建分别使用 `MINIS_TIKTOK_APP_ID` 和 `MINIS_TIKTOK_CLIENT_KEY`。开发阶段不保留 `VITE_APP_CODE` 或 `appCode` 协议兼容。

## 运行期

1. 公开目录与 Bootstrap 只发送 `tiktokAppId`；API 按官方 ID 定位启用应用，客户端核对响应中的同名字段。内部 `applicationId` 仅用于服务端数据与用户身份隔离。Bootstrap 返回固定 `playbackSdk.provider=tiktok_minis`、`channel=byteplus`，不返回取证开关、云密钥或媒体 URL。
2. H5 完成静默身份校验，使用官方 Player 能力；通过 X-Mini-Version 携带包版本以匹配应用审核配置，不保留旧版播放 Token 分支。
3. API 完成应用、内容、媒资、授权和用户权益校验，返回官方播放标识，不创建播放取证会话。
4. H5 使用 `albumId`、`episodeId`、`vid` 初始化官方 Player；描述符只保留在内存。
5. 广告位和解锁规则由 API 按应用下发，H5 不维护静态广告位配置，也不自行判定最终权益。

观看进度、收藏和历史只在当前客户端保存，按应用与 Visitor 隔离；刷新可恢复，跨设备与清除数据后不保证恢复，不向服务端同步。生产包、真实登录、IAA 和播放验收只能在 TikTok 设备预览中执行。
