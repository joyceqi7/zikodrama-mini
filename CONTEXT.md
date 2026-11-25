# 当前状态

## 2026-10-11 统一替换 Web License

用户明确要求用新文件替换旧许可，所有 Mini 共用，不增加应用级许可字段。新文件 `src/assets/veplayer/l-20322334481-ch-vod-a-1072774.lic` 与用户提供文件字节一致，基础版授权 `*.tiktok-minis.us`；原许可 `l-47018034705-ch-vod-a-1062843.lic` 已从源码移除。独立适配器直接导入新许可，质量日志 AppID 为 `1072774`，provider、VID 与权益仍由服务端决定。官方播放器路径及已发布旧包保持原样。

按用户指令，移除本次新增的测试用例及临时域名诊断产物，原有播放器测试只同步许可 import 文件名。未修改 server/admin 或全局配置，BytePlus 工单未提交。用户自行打包、上传和真机验证，停止平台操作；新许可真机播放未验证，不能声明已恢复播放。

开发阶段曾完成包含新增用例的验证（448 项 Vitest、34 项 Node）及 Glimora Sandbox 平台打包。用户收窄任务前已创建预览版本 14，未送审、未发布；该预览和现存 ZIP 生成于本轮最终简化之前，用户应从当前源码重新打包。本轮统一替换后 `make verify` 全部通过：44 文件/444 项 Vitest、32 项 Node、类型检查及 Web 构建，日志 `/tmp/drama-mini-license-replace-verify.log`。未新增测试用例，未重新平台打包或上传。

## 2026-10-11 Glimora 排查记录（新许可接入前）

按应用 `7694137787536181256` 启动本地官方扫码调试，API 指向 `https://testservice.tkdrama.site`。公开直连目录正常返回 3 部短剧；普通浏览器因 TikTok 静默登录超时无法验证受保护播放链路。通过用户已打开的 iPhone 镜像确认平台预览包显示 `12002 / license domain name does not match`；当前随包许可及控制台应用 `1062843` 绑定 `*.tkdrama.site`。实际平台页面域名尚未取得，需匹配许可后重新构建并真机复验，不能以 API 域名推断许可覆盖。

同时复现并修复独立的启动时序问题：预热早于 bootstrap 时会使用占位官方 provider 调用 getPlayer。现在等现有启动任务安装身份和通道后再准备对应播放器；失败或无身份时不加载默认通道，也不额外换码。新增回归覆盖直连/官方延迟启动及失败后明确重试，聚焦 56 项通过；`make verify` 的 44 文件/447 项 Vitest、32 项 Node、类型检查及 Web 构建通过，日志 `/tmp/drama-mini-provider-verify.log`。未修改测试环境数据库或配置，未部署或替换许可，预览包播放尚未恢复。

后续按用户“做”的指令执行 Glimora Sandbox 平台打包，官方 CLI 校验通过，解压体积 2.63 MB。标准包位于 `~/__TTMinis__/mn23su3q2uw0yt3p/minis.zip`；仅在临时复制的构建产物中插入只读域名面板，诊断包另存 `glimora-sandbox-host-diagnostic-20261011.zip`。面板只读取 `location.hostname` 和协议，不读取查询参数、身份或播放凭据，不修改客户端源码。已上传 TikTok 为预览版本 13，备注禁止送审或发布；用户扫码后通过镜像取得实际 HTTPS 页面域名 `minis-mn23su3q2uw0yt3p-3v1jv2b9vskjs-3.tiktok-minis.us`，证据截图 `/tmp/drama-glimora-host-v13.png`。此域名不在 `*.tkdrama.site` 下；它是 TikTok 分配的域名，不能假定用户拥有 `tiktok-minis.us` 根域名，或假定一个构建版本的主机名永久不变。控制台点击应用域名修改入口，明确提示“已绑定License，不可修改”；不能直接修改现有基础版绑定。用户在控制台另生成的基础版 License `15729711633`/包 `42440774929` 仍绑定相同应用 `1062843`，当前域名仍为 `*.tkdrama.site`，不是匹配新页面的授权。待 BytePlus 确认该容器的基础版签发与授权范围；技术支持请求草稿见直连说明，尚未提交。原有预览、审查版本和线上应用未替换，License 与播放均未修复完成。

## 2026-10-10 渠道独立发布

Mini 只读取当前渠道上架的短剧、分集及播放授权，不管理或要求内容版本字段，保持现有消费者接口。重新取得目录后清理旧预取及迟到授权，保留已挂载播放、本地进度、收藏和身份；provider 仍由服务端可信启动配置决定。

新增回归测试覆盖重新获取连载内容和新增分集播放授权，确保消费者请求不传发布管理版本。短剧就绪及渠道发布版本均由运营端和服务端维护。

本轮聚焦 API 测试 25 项通过；`make verify` 中 44 文件/444 项 Vitest、32 项 Node 脚本、类型检查和 Web 构建通过。测试执行时限制 Vitest 工作进程数量，未修改业务配置；构建保留既有入口占位符和 SDK 分包体积警告。日志：`/tmp/drama-mini-channel-final-verify.log`。未执行平台打包、License 真机验证、真实 TikTok/BytePlus 调用或部署。


## 2026年10月 VePlayer 双通道

feat/veplayer 共用页面、身份、广告与权益，官方应用继续宿主 Player，byteplus_web 在独立适配器懒加载 @byteplus/veplayer 1.19.1。使用服务端验权的 VID/短时 Token，基础版无高级预加载，SDK 故障受控重新验权并恢复位置。44 个测试文件/403 项 Vitest、Node 策略、类型与 Web 构建通过；未执行真实 License、TikTok 真机、平台打包或部署。详见 [直连说明](docs/veplayer-direct.md) 与 [上线手册](../drama-server/docs/veplayer-release-runbook.md)，下文为历史记录。

`drama-mini` 已从参考工程的 React、Vite、TikTok Minis 打包、平台适配器、VePlayer 适配器和测试结构初始化。

当前代码仅作为迁移基线；后续实现以 TikTok 官方接入文档、BytePlus VOD 和新系统 API 合同为准。尚未执行真实登录、IAA、VePlayer 设备预览或生产打包。


## 2026-09-12：移除字幕与多语言

消费者界面固定英语，管理端固定中文。内容与 VIP 文案只维护主字段，标签使用官方名称。应用语言配置、翻译编辑、语言协商及字幕生成/管理/发布阶段已移除；原始音频语言元数据保留。服务端要求 Schema `2026-09-12-v21`，服务启动不会自动改库。


## 2026-09-15 数据库自增 ID 合同验证

`applicationId` 是服务端数据库自增主键的十进制字符串；`tiktokAppId` 保留官方原始值，包括前导零。新增 API 合同测试覆盖 `9007199254740993` 和 `18446744073709551615`，不做 JavaScript 数值转换。该聚焦测试组 14 项通过，最终 `make verify` 的 254 项 Vitest、Node 脚本测试、类型检查与 Web 构建通过。本次未执行平台打包、真机验证或部署。

## TikTok 分类排行榜（2026-09-15）

首页改为并行请求 `GET /api/v1/open/home/carousel`、`GET /api/v1/open/home/hot` 与 `GET /api/v1/open/home/rankings`；这些公开接口在 SDK 与登录完成前启动，任一区域先返回就先渲染。分类榜返回 `[{tagId, name, dramas}]`，H5 按官方标签 ID 切换、按服务端人工顺序排名，点击沿用登录和播放门禁。英文名由后台 TikTok 标签菜单维护，空分类不展示。


## 2026-09-16：应用更新显式提交变现模式

服务端开发期合同不再接受省略变现模式。`scripts/prepare-local-catalog.mjs` 的应用更新请求显式传回 `application.monetizationMode`，消费者公开 API 与 H5 运行代码未改变。没有执行目录准备脚本的外部写入或真实平台调用。

脚本语法检查和目录准备的 7 项 Node 聚焦测试通过；`make verify` 中 277 项 Vitest 和 24/25 项 Node 测试通过，Minis CLI 真实启动测试遇到端口断言差异，单独复测通过。另行类型检查和构建通过。未声明整套 verify 单次全绿，未部署。日志：`/tmp/drama-no-history-mini-verify.log`、`/tmp/drama-no-history-cli-retest.log`、`/tmp/drama-no-history-mini-focused.log`、`/tmp/drama-no-history-mini-build.log`。
