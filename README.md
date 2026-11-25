# drama-mini

当前版本已移除字幕与多语言：消费者界面固定英语，管理端固定中文，内容只维护主文案；原始音频语言仍作为官方发布元数据。
验收要求见 [单语言与无字幕验收](docs/single-language-release-checklist.md)。

TikTok Minis 官方短剧系统的观众端 H5 客户端。

新版 Mini 已共用页面、登录、广告和权益，按启动配置支持官方播放器与独立 VePlayer。旧官方接口合同保持兼容。详见 [完整实现方案](../drama-server/docs/veplayer-implementation-plan.md)、[直连播放说明](docs/veplayer-direct.md) 和 [实施与上线手册](../drama-server/docs/veplayer-release-runbook.md)；真实 License 与 TikTok 容器仍需上线验收。

## 职责

- 接收 TikTok Ads 跳转参数并解析官方 Minis Link。
- 展示短剧目录、剧集详情、观看进度和解锁状态。
- 通过 `TTMinis.getPlayer("byteplus")` 获取 TikTok 官方 Player，播放 API 权益校验后下发的官方 Album/Episode/VID。
- 独立应用仅在直连适配器懒加载 `@byteplus/veplayer@1.19.1`，使用服务端验权的 VID 与短时凭据；基础版不调用高级媒体预加载，不要求原片先转码。
- 调用 TikTok 激励广告，并仅在 `isEnded === true` 后申请服务端权益。
- 生产与预发播放及广告解锁必须完成 TikTok 静默登录；不申请头像、昵称、手机号等用户资料授权。
- 通过官方 `reportEvent` 回传播放请求、实际播放和广告展示，不将事件回传作为权益或收入证明。

## IAA 启动与解锁

当前按广告变现接入，不新增支付、充值或订阅流程。页面打开时并行读取 `GET /api/v1/open/catalog?tiktokAppId=...` 与执行静默登录。`/api/v1/open/*` 均不等待登录或携带 VisitorToken。公开目录只含当前应用已发布的短剧摘要；登录等待或失败期间可以浏览、选择剧目，待身份恢复后再进入播放页。公开目录不提供播放参数、个人状态或广告奖励 Offer，也不会创建匿名会话。

完整观看激励广告后才申请奖励，原有 `claimId` 幂等结算与待领取补偿继续生效；广告取消或失败不发奖。跨次进入恢复的是后端已确认的解锁权益。观看进度、收藏和历史按应用与 Visitor 隔离保存在本机，不提供跨设备同步。广告来源的 VIP 是奖励权益，不是付费订阅。

## 身份与故障处理

`applicationId + visitorId` 标识服务端确认的业务主体，`visitorToken` 是调用自有 API 的凭据。OpenID 不替代鉴权；无须用户注册、填写资料或主动登录。当前 VisitorToken 没有到期时间字段，与 TikTok 平台 Token 的生命周期无关。

只对 `401 + unauthorized` 执行一次静默恢复；应用或权限限制、业务拒绝、限流、服务故障和网络故障分别处理，不触发登录循环。恢复前后不是同一主体时，不重放旧请求；待领取记录按应用与 Visitor 隔离。断网、超时或无法确认结算结果时保留原 claimId，后续按同一主体幂等重试。

消费者启动不做 IP/安装标识限流，不采集 `installationId`；每日奖励上限仍是服务端业务规则。SDK 登录失败、超时或不支持时显示对应友好提示，不发送缺码启动请求。身份安装失败后保持业务请求封闭，通过公开目录中的“重试”入口完整恢复，不要求用户退出小程序。

待领取队列在 Storage 故障时使用当前页面内存兜底；未成功持久化的记录无法保证跨页面重开恢复。补领逐条确认后立即通知当前主体的播放页清理许可缓存并重新校验，不再为每次领奖额外静默登录和全量刷新启动配置，避免播放授权被不必要的身份刷新阻塞。

状态码、错误码与恢复边界以 [消费者接口合同](../drama-server/docs/api-contract.md) 为准。真实静默登录和 IAA 仍须设备预览验证，不能用本地替身结果替代。

## 广告故障与回传边界

广告展示确认等待上限为前台累计 15 秒，展示后关闭回调等待上限为前台累计 5 分钟；这属于客户端恢复策略，不代表官方广告时长。WebView 隐藏时暂停计时，恢复可见后继续。超时只返回失败并恢复操作，不发放奖励；迟到的关闭和失败回调不会重复处理。关闭或错误监听解绑失败会记录具体原因，并继续完成其他清理和已确认的结果。

IAA 广告事件固定广告发起时的身份、剧目和上一集实际播放事实，切剧不改绑，切换主体后丢弃旧回调。直接进入锁定集时保留已知剧目，不把目标集当成上一集；没有实际播放的上一集时省略 `episode_number`。离开播放页后清空剧集上下文，首页广告只携带已知应用和身份字段，未知布尔标记使用 `null`。官方字段表没有明确说明无上一集场景的完整字段组合，以上省略策略尚待平台真机回传验收，不等同于已被官方接受。

本机已通过广告创建/注册/解绑异常、取消、前后台超时、迟到回调、直达锁集、切剧及换号等聚焦测试；浏览器使用实际 App 和平台替身验证故障恢复，不代表真实广告展示、回传接收或收入已验收。

## 开发

```bash
npm ci
make dev
make verify
```

本地、预发与生产共用真实 API 和 TikTok 官方 SDK，不再提供浏览器模拟运行模式。普通浏览器可加载公开目录；登录、广告及官方播放器需要通过 TikTok 官方开发调试桥接或设备预览使用。没有官方能力时显示统一错误，不生成模拟身份、模拟播放或广告奖励。自动化测试中的 SDK 替身只验证异常与状态流转。

真实登录、IAA 和播放验收必须在 TikTok 设备预览中完成。

`make dev` 默认读取纳入 Git 管理的 `.env.development`，通过 `https://testservice.tkdrama.site` 访问 ECS 测试 API，避免浏览器与 TikTok 容器拦截 HTTP IP 直连。请在 `.env.development.local` 中设置 `VITE_TIKTOK_APP_ID`，值为后台应用管理显示的 TikTok 官方 AppID；示例不预填真实应用。不能填写内部 `app_...` ID、业务编码或 Client Key。`VITE_TIKTOK_CLIENT_KEY` 继续独立供官方 SDK 使用。修改环境配置后需重启开发服务。

### Minis 扫码联调

先确认手机客户端，避免将本地调试码当作平台预览码使用。按 [Develop Your Mini Drama](https://developers.tiktok.com/docs/en/tiktok-minis-develop-your-mini-app) 的客户端准备说明：

- Android 本地联调需要 TikTok 官方提供的测试客户端，通过 TikTok 运营联系人或官方支持工单获取。
- iOS 使用平台设备预览：将打包产物上传到开发者平台，扫描平台生成的预览二维码。
- 以下 `make dev-minis` 生成的是本地调试桥接二维码，不能将普通客户端扫码后的网页 404 直接归因于业务页面或 API。

执行以下命令后，从终端菜单选择需要预览的应用：

```bash
make dev-minis
# 等同于 npm run dev:minis
```

菜单读取 `configs/apps/*.json`，并自动注入所选应用的 AppID、Client Key、名称、图标和 Sandbox API。CI 或其他非交互环境必须明确指定 AppID：

```bash
npm run dev:minis -- --app 7685293427067586568
```

打包命令使用同一选择器；人工执行 `npm run build` 时进入应用选择菜单，自动化环境继续使用 `--app`：

```bash
npm run build -- --app 7685293427067586568 --deployment production
```

两个应用需分别打包，例如 `make package-production APP=7685293427067586568` 与 `make package-production APP=7685989013308475410`。项目先调用官方 `minis build --no-zip` 检查入口与体积，再将 `dist` 压缩到 `~/__TTMinis__/<所选应用 Client Key>/minis.zip`；打包结束时确认终端输出路径和包内应用身份。官方 CLI 0.0.7 的直接 ZIP 步骤会优先读取本机 `~/.ttminisrc` 的 Client Key，多应用共用电脑时可能覆盖另一应用的压缩包，因此不要直接运行裸 `minis build` 来生成上传包。

需要用版本预览二维码复测投放落地时，为单个应用传入 `--preview-campaign <投放码>`。请使用该应用上已启用的投放配置中的编码。预览输出 `minis-campaign-preview.zip`，扫码进入后会走真实的静默登录、投放解析和播放验权。要通过版本二维码复现新短链的首屏封面和剧集摘要，改用 `--preview-launch-path '<运营接口返回的 minisPath>'`。正式打包时省略预览参数。

入口读取所选应用配置，在系统临时目录生成已替换 Client Key 的 HTML，再启动项目固定版本的官方 `minis dev`。CLI 自动启动当前项目的 Vite 服务，优先使用 5173；端口已占用时自动选择空闲端口，并同步给 CLI 与 Vite，避免误连其他应用或旧环境。真实页面仍从当前项目加载，支持原有热更新。退出时清理本次创建的临时目录和服务，不修改源码 HTML、`minis.config.json` 或生产打包配置，也不停止原有服务。

不要在项目根目录直接运行 `minis dev`：CLI 0.0.7 会在 Vite 替换变量前校验源码，将 `%VITE_TIKTOK_CLIENT_KEY%` 误当成实际 Client Key。也不需要将应用的 Key 写死进 `index.html`。

电脑与手机连接同一 Wi-Fi，手机 TikTok 账号须加入当前应用的测试用户。使用 TikTok 扫描 CLI 打开的调试页二维码，并保持 TikTok 前台运行；连接失败先看调试页的网络诊断及 Node/Client WebSocket 状态。官方说明见 [Debug Your Mini Drama](https://developers.tiktok.com/docs/en/debug-your-mini-app)。真实播放与广告验收仍需完成平台设备预览。

播放故障诊断配置在 `src/config/playbackDiagnostics.json`：`previewConsole` 为 true 时，Sandbox 包按 TikTok 官方文档加载 vConsole，仅启用日志面板。标准正式包在编译期剔除面板、专项时序输出和固定投放预览入口。上传新的 Sandbox 包后，点击手机上的 vConsole 查看 `player_configuration_ready`、`playback_authorization_resolved`、`direct_player_license_*`、`direct_player_media_info_ready`、`player_media_event` 和错误事件。前台请求播放后 15 秒仍未出画时，`player_startup_pending` 采样最后事件、媒体元素是否仍连接、readyState、networkState 和媒体错误码；该采样不会终止或重试播放，也不能单凭它认定平台拦截。日志不包含 Token、License 内容、签名或媒体 URL；vConsole 不启用网络、存储和元素面板。平台豁免仍须由 TikTok 确认。

## 真实 API 与 MySQL 本机验证

2026-09-09 已使用实际 App、`HttpMiniDramaApi`、Go Handler 和独立 MySQL 验证：广告完整回调后解锁、刷新与后端进程重启后的权益恢复、账号切换隔离、响应丢失后的待领取补偿、管理端免费范围／解锁集数／每日上限联动。广告取消及失败不解锁，失败可重试且保留具体诊断日志。待领取属于原账号，切号不消耗，切回后按原 `claimId` 恢复。

权益变化时同时重新加载播放许可和分集详情，避免到账后选集面板继续显示锁标；每日奖励上限提示明天再来，与短时请求限流分开。桌面与 390px 子视口完成页面及选集操作；浏览器视口覆盖未生效时采用同源 iframe 验证 CSS 响应式，不代表真实移动设备。

服务端自动化入口为同级 `drama-server` 的 `make test-integration-local`。上述浏览器验证的平台换码、广告回调及播放器均为替身，未验证真实广告填充、音视频播放或平台事件接收。

## 50008：前后台门禁与展示意图

宿主通过明确子码或 `inner_error_code=50008` 表示容器不可用。通用主码 `101150000` 不能单独归为这一类；原始主码、子码与内部码分别保留。

- SDK 初始化成功后立即安装页面级前后台监听。所有业务组件共享网页与宿主状态，组件重挂载、退订及 SDK 对象替换不会把已知原生后台重置成前台。首次尚无宿主事件时标为 `unknown`，在网页可见且浏览器未明确预渲染的条件下允许首次尝试，不无限等待未承诺重放的 `minis.show`。
- 创建前与实际 `show` 前复核同一可见性版本和业务意图。后台往返、换页、换主体、Offer 或门禁目标变化后，旧请求不会继续展示；前台恢复按当前入口重新判断。浏览器 `document.prerendering` 只作为明确为 true 时的门禁，不能反推 TikTok 原生容器状态。
- 剧目查询与广告并行，移除展示前最多 1.5 秒等待；只有官方展示事件回传通过已有 `contextReady` 等待资料。奖励仍绑定原 ClaimID/主体，只有 `isEnded === true` 可结算。
- 未展示的明确 50008（包括只有 `onError`、show Promise 未结束）释放本次锁并立即清理实例监听，不保留失败后的诊断观察窗口。已展示后报错仍持有原生锁直至 `onClose`/容器销毁，前后台切换不是关闭证明。
- 50008 暂停当前前台周期的自动请求，不靠固定五秒时间推断恢复。新的真实前台转换、首次宿主前台确认或用户手动重试才能重新评估；重复前台信号不恢复，重试创建新广告实例；获得原生展示证明后清除旧暂停，允许正常自动衔接。插屏机会不排队补播；其他 SDK 故障仍遵守原退避规则。
- 入剧展示模式以服务端确认的有效达标进度放行，SDK 后续故障不撤销已确认次数；原生广告互斥继续独立维护。VIP 的前台恢复发生在旧 Offer 返回前后均可重新评估；自动接续先等待旧原生广告结束，等待期间仅检查本地状态，不调用广告业务 API。关闭弹窗、卸载和后台会取消检查；原生等待超时仍按未知结果停止，普通故障仍等待用户重试。
- 原始三种错误码保留在既有统计中。失败只附 show 前、报错时的可见状态、本地锁持有者及前次实际 show 的结束事实；没有快照数组或逐点时序。错误详情和内部错误消息分别脱敏并限定为 192 个 UTF-8 字节。

保持官方短剧 H5 的 create → 注册回调 → show 顺序，每次使用新实例，没有加入小游戏独有加载接口。依据：[短剧广告示例](https://developers.tiktok.com/docs/en/tiktok-minis-in-app-ads)、[SDK 生命周期事件](https://developers.tiktok.com/docs/en/minis-sdk-event)、[官方错误码](https://developers.tiktok.com/docs/en/mini-games-error-code-reference)。本地受控 SDK 用例验证调用时序和恢复规则，不能证明真实宿主的内部预渲染故障已消失。

三端发布顺序及排障字段见 [广告统计合同](../drama-server/docs/ad-analytics.md)。先执行新增 SQL，再更新 Server/维护进程、Admin，最后更新 Mini；本次仅修改本地分支，不执行这些发布操作。

广告错误现场通过独立的 `POST /api/v1/ad-errors` 发送，`/metrics` 只保留现有事件和错误码，不再接受 `adFailure`。正常广告、未完播、本地拦截和结果未知不会发日志请求；每次调用的首个 `ad_failure` 才进入日志队列。服务端校验后直接写 `client ad failed` 结构化日志，不等待统计入库，不新增 MySQL/Redis 写入。按应用、内部用户 ID、调用 ID 到日志服务查询；后台只显示统计事件和原始错误码。

发送策略位于 `src/config/adErrorPolicy.ts`：2 秒合批，每批最多 5 条，内存队列最多 20 条，同一页面两次发送至少间隔 10 秒。失败批次不重试，后续批次退避 60 秒；队列满丢弃新增现场，换号/会话失效丢弃旧现场，退出不补发。日志接口的 401 不触发登录恢复，日志上传失败仅打印脱敏本地日志，不递归上报。原有统计独立发送、重试，错误总数不因日志限流而采样。

服务端每请求最多 8 KiB、5 条，复用 Visitor 鉴权和有界内存限流器；配置 `business.ad_error_requests_per_minute: 6` 同时限制单实例内同凭据的鉴权请求数与同应用、同用户的日志请求数。鉴权前只用凭据摘要限流，获准请求仍完整鉴权；超限返回 429，拒绝请求不继续读取主库凭据版本。该限制不等于多实例总配额。每个 SDK 仅保存前一次实际 show 的调用键、释放原因与已收到的关闭时刻，不维护历史数组。日志属于尽力保存，断网、限流、队列满、退出或采集故障可丢失现场；容量仍须按实际失败率评估，不能把 10 万 DAU 等同于 10 万广告或宣称已完成压测。


## 手填版本与审核加白

在 `configs/mini-version.json` 中修改 `appVersion` 即可调整 Mini 的默认业务版本，构建时将它固化到包内。单个应用需要独立版本时，在 `configs/apps/<TikTokAppID>.json` 中设置 `appVersion`，打包和 `dev:minis` 会优先使用应用配置。版本号接受无前导零的三段数字，最长 32 字节。构建产物 `mini-build.json` 记录业务版本、Git 修订和时间。

所有消费者请求携带 `X-Mini-Version`。后台应用配置中手填审核版本号并开启开关，首页内容在「加白管理 → 审核内容清单」维护。只有应用与包版本精确匹配时，轮播、热门、分类榜和 More 才限制到清单；搜索和分享直达不受首页范围影响。纯 IAA 在该版本中仅执行原有逐集激励规则，关闭入剧、广告 VIP 和普通插屏，关闭审核后恢复最新完整策略。

首页先确认有效配置，再读取按业务版本及审核修订隔离的缓存；More 显式使用 `placement=home`，避免影响普通目录查询。服务端升级与网关允许请求头配置见 [审核加白合同](../drama-server/docs/mini-review.md)。
