# TikTok Minis 独立 VePlayer 接入

本客户端在当前配置为 byteplus_web 的应用内使用 `@byteplus/veplayer@1.19.1`，不将短剧上传 TikTok 媒资库，不调用 getPlayer 获取播放器。官方应用继续按 [官方合同](tiktok-minis-official-player.md) 工作。两种应用共用 TikTok 身份、激励广告、分享、页面、本地记录和 API 客户端。

## 2026-11-18 Lite 接入验证

固定 1.19.1 包提供官方 `lite` 入口，但它不是可直接替换此独立 VID/短时 Token 接入的基础授权版。真实构造时，未安装 `TTDramaEnv` 会同步抛出 `VEPLAYER_LITE_UNSUPPORTED_ENVIRONMENT`；只检查导入、静态许可方法和事件存在，不能证明能够起播。其宿主环境需要短剧信息桥接，正式宿主取流还涉及官方 Album/Episode 映射，与当前独立通道合同不同。

本轮保留 Full 入口及服务端权威 provider，不用伪造环境绕过 Lite 限制，不切换播放通道。账户页代码预载、目录与当前集授权保持现有并行关系；Lite 候选构建仅用于体积和兼容性验证，未上传或发布。后续只有取得厂商确认支持独立 VID/Token 的精简构建，或另行批准正式宿主通道接入，才能重新评估替换。

## 页面视频校验验证分支

独立播放器在 `src/player/vePlayerEngine.ts` 的初始化入口调用 `src/platform/tiktok/directPlayerExemption.ts`。处理先等待官方 SDK 初始化，再覆盖其两秒原生配置查询窗口，将已初始化 Mini 的 Client Key 加入当前页面实例的播放白名单。等待时长由 `src/config/timePolicy.ts` 的 `directPlayerVerificationSettleMs` 配置，当前为 2200 毫秒；同一 SDK 实例共享一次处理。包内 VePlayer SDK 与 CSS 在等待期间并行加载，页面校验与资源加载均完成后才配置许可并返回播放器构造器；首页预热也不能提前创建播放器。

处理依赖 2026-11-05-21-27-24 公开 SDK 中的 `window.__ttMinisVideoSecurityInstance` 及其内部配置方法，不改变 Developer Portal 的官方豁免状态。接口不可用、实例更换、身份不一致或写入未被接纳时，初始化明确失败并保留人工重试；显式黑名单按预期拒绝记录。已失败的视频节点可能已被清空媒体源且缓存了失败结果，因此必须先完成处理再新建播放器。

真机先确认 `direct_player_exemption_ready`，最后以真实首帧和连续播放为准；失败查看 `direct_player_initialization_failed` 的脱敏错误。用户已在先前基于 `feat/ads` 的验证分支确认可以播放；合入后的组合仍需重新打包验收，打包和真机验证由用户执行。

TV（`7686257308368291860`）、Talivo（`7702288092098594824`）和 Rivora（`7702381145916327954`）使用各自的 `configs/apps` 应用配置，保留原有部署目标及公开身份配置。

## 启动与授权

包内 VITE_TIKTOK_APP_ID 和 Client Key 按应用构建；provider、channel、capabilities 来自服务端 bootstrap；SDK AppID 与 License 由包内配置 `src/config/veplayer-licenses.json` 维护，原始 `.lic` 放在 `src/assets/veplayer`。客户端按 `window.top.location.hostname` 选择许可，不通过后台配置或启动接口下发，不以 TikTok AppID 或设备类型猜测域名。校验返回应用身份，明确未知 provider 或缺少配置拒绝启动，不提供播放器回退。新版 Mini 上线后，运营可按播放修订修改已有应用的通道；应用身份、权益和本地历史不变，重启新版 Mini 后按最新启动配置选择播放器。目标通道的内容发布和首页配置独立维护，不自动复制。

首页定时预热与深链预热共用 `/open/app-config` 确认播放通道，不以初始占位的官方 provider 调用 getPlayer。确认 `byteplus_web` 后即可加载包内 SDK/CSS，与 TikTok SDK 初始化、登录、VIP 查询及落地解析并行；许可配置仍等待官方初始化完成后的 2200 毫秒页面校验。官方通道等待配置、SDK 与身份安装后准备构造器，与可信落地解析并行，且不执行独立 SDK。bootstrap 仍等待可信落地目标，不等待 VIP 查询，剧场可提前读取入剧进度与目标详情；强制 VIP 门禁仍等待权威权益状态。两种通道都不因预热额外换码或自动恢复会话；实际播放仍必须取得服务端对当前观众、剧目和分集的有效授权。

VePlayer SDK 与 CSS 已随 `dist` 进入 Mini 压缩包，按需加载不表示从外部 CDN 引入播放器脚本。资源加载和页面校验共享同一次初始化，任何一侧失败都保留实际错误诊断且不交付构造器；License 更新和媒体请求仍使用原有官方链路。

DirectVePlayerAdapter 仅在直连分支动态 import SDK 与 CSS，将选中 `.lic` 的 Content、Signature、MainURL 原样作为 SDK 的 `content`、`sign`、`mainUrl` 传给 `setLicenseConfig`，等待完成后创建 Player。同一页面的适配器、预热和重建共用一次许可初始化。15 秒等待超时允许人工重试，但不可取消的在途 SDK 调用仍共享，避免并发验签；实际验签失败后释放缓存，下次重新初始化。SDK 的质量日志 `line_app_id` 使用选中许可对应的 BytePlus AppID，只在 SDK 整数参数边界转换。该标识不是 TikTok AppID，不决定 provider、VID 或播放权限，也不传业务观众 ID。服务端不再下发 SDK AppID，播放 Token 有效期改为服务端配置文件的 `business.direct_playback_token_ttl_seconds`（60～900 秒，示例 300 秒），修改后重启 API 实例；它不会改变 License 授权范围。

## 四域名许可与自动更新

2026-10-12 已接入以下四份正式基础版许可。配置按域名后缀匹配根域及子域，并检查点号边界；例如 `tiktok-minis.us.evil.example` 不会命中。顶层域名不可读、未知域名、文件缺失、许可内容域名与配置错配、MainURL 缺失或非 HTTPS 均拒绝直连初始化，不复用另一域名的许可。

| 授权域名 | SDK AppID | 随包文件 | 当前到期日 |
| --- | --- | --- | --- |
| `*.tiktok-minis.us` | `1072774` | `l-20322334481-ch-vod-a-1072774.lic` | 2027-10-11 |
| `*.tiktokminis.us` | `1073274` | `l-15729717777-ch-vod-a-1073274.lic` | 2028-10-12 |
| `*.tiktok-minis.eu` | `1073276` | `l-15729719569-ch-vod-a-1073276.lic` | 2028-10-12 |
| `*.tiktok-minis.com` | `1073277` | `l-16620622609-ch-vod-a-1073277.lic` | 2028-10-12 |

四个域名共用同一个 VePlayer SDK，按当前页面选择一份许可，不创建四个播放器。配置中的 `localDebugDomain` 明确指定 localhost、127.0.0.1、[::1] 调试时使用的许可；本机调试权限来自官方 SDK，不表示真实平台域名已验收。其他本机或自有域名没有许可回退。

根据 [BytePlus 官方说明](https://docs.byteplus.com/en/docs/byteplus-vod/docs-getting-started-with-the-web-player-sdk)，`mainUrl` 由 SDK 在许可升级、续费时自动更新最新版本，业务代码不自行轮询、不修改 Content 或 Signature。同一许可续费且更新地址不变时，可由 SDK 获取新版，无需仅为续费重打包；新增域名、更换 SDK 应用或更新地址则须更新包内配置与原文件、重打包。自动更新依赖容器能访问对应地址，不能替代真机验证。

四份许可的更新地址使用 `sf16-vod-license-multi.byteplusvod.com` 与 `sf19-vod-license-multi.byteplusvod.com`，已加入包内 `minis.config.json` 的 `domain.trustedDomains`。上传前还须在目标 Mini 的 Developer Portal Security 中登记这两个请求域名，见 [TikTok 请求域名配置](https://developers.tiktok.com/docs/en/set-up-development-configuration)。当前修改只涉及包内配置，未修改平台配置。

播放器来源包含 provider=byteplus_web、VID、playAuthToken、expiresAt，不允许带官方 Album/Episode 映射。凭据到期不足 5 秒拒绝挂载。API 请求仍只传内部 dramaId、episodeId，不传 VID 或 provider；X-Mini-Version 仅匹配应用审核配置；接口路径保持 `/api/v1/*` 与 `/api/v1/open/*`。

锁定直连集只接受元数据和解锁入口，不接受 playback 或 preload。已授权源只在内存保存，不写本地进度、收藏、历史或日志；公开首页不含播放凭据。

## 基础版与原片

基础许可使用同一有效 Token 调用 `prefetchMediaInfo`，只往 SDK 内存预取播放信息。投放首集在服务端确认授权且 SDK 已就绪时提前提交。第一次挂载收到 `LOAD_START` 后，才提交紧邻下一集已确认的可播授权，避免后台查询占用首集查源阶段；未收到加载事件或之后连续切集，仍由当前集首帧结束后提交。挂载和 `playNext` 优先接管尚未发出的任务。已发出且领先至少 150 毫秒的同一授权，可在预取开始后的 270 毫秒内接续（前台最多再等 120 毫秒）；失败或到点后由播放器正常查源。换观众、进出后台或授权作废时清理缓存。

跨视频字节预加载所需的 `prepare`、`setPreloadList`、`setPreloadScene` 和 Mp4MSE 保持关闭。清晰度和格式由已授权 VID 的可用源决定；媒体仍须通过目标设备的编码、容器和弱网验收。

实例生命周期共用 SDKPlaybackEngine：首帧、播放/暂停、倍速、进度、结束、隐藏恢复、切集与销毁保持页面合同。Player 内部单视频缓冲和 API 元数据预取不等于高级跨视频媒体预加载。TikTok 官方能力仍通过 src/platform 使用，不模拟广告或身份。

## 错误与奖励恢复

SDK 错误或首次挂载失败时，每次进入分集最多自动恢复一次：写回本地进度、销毁实例、清除来源缓存、重新调用 resolve 验权，再挂载有效源。同次进入且 VID 未变时，就绪后只恢复一次有效位置，并保留故障前的播放或手动暂停意图；替换 VID 不复用旧媒体进度。迟到响应受路由/请求代次/访问代次/存活栅栏保护；第二次失败显示统一英语提示并等待用户重试。手动重试同样释放故障内核，安装新 Token，并开启新的一轮恢复预算，不能复用出错实例或重看广告。

重建期间进入后台会撤销在途请求的提交权；回前台即使内核已释放或原来手动暂停，也必须重新调用 resolve，取得当前许可后才挂载。权益刷新或奖励许可抢占恢复请求时，同样按当前访问更新恢复门禁与 VID；后台权益通知不能代替前台验权。连续前后台切换只接纳最新前台响应，后台完成的旧 Token 不能用于恢复；未就绪内核的零进度和默认暂停不能覆盖故障前保存的状态。手动重试的忙标记只归属当前请求代次，作废请求不阻止新重试，旧请求结束也不能解除新请求的占用。

SDK 的 READY/COMPLETE 仅表示实例或 video 已创建，不能据此消费恢复位置。媒体时长就绪后才发起定位，并在内核确认目标位置后清除恢复上下文；暂停恢复也通过 durationchange/canplay 继续确认，不依赖时间推进。定位确认前不接纳零进度和首帧，期间再次进入后台仍保留原位置。

奖励已提交而服务端签发失败时，API 仍返回已确认奖励并省略播放源；Mini 保留解锁事实，使用当前身份重新解析。claimId、待领奖、广告完成回调和应用/Visitor 隔离沿用已有流程。后台和日志禁止记录 Token、Cookie、License 内容、签名媒体 URL 或 SDK 原始异常。

## 验证与开放

平台预览包出现 `12002 / license domain name does not match` 时，检查播放器页面的实际 `window.top.location.hostname`，不是消费者 API、视频 CDN 或 License 文件的存放域名。核对四域名配置命中的许可及其授权范围；替换许可时同步配置文件中的文件名与 SDK AppID，再重新构建预览包验收。不要修改签名文件中的授权域名来绕过校验。BytePlus 对 localhost 和本地 IP 使用特殊调试权限，本地成功不证明平台许可有效，见 [官方 License 配置说明](https://docs.byteplus.com/en/docs/byteplus-vod/docs-getting-started-with-the-web-player-sdk)。另外按 [TikTok 请求域名配置](https://developers.tiktok.com/docs/en/tiktok-minis-develop-your-mini-app)核对实际 VOD 查询与媒体请求的允许域名；两种限制分别排查。

2026-10-11 已在 Glimora 真机确认 12002，BytePlus 应用 `1062843` 的域名修改入口明确提示“已绑定License，不可修改”。不能将重新下载同一份许可视为修复，也不能假定已绑定应用可以自助换域名。取得实际容器域名后，再确认新建 Web/H5 应用签发基础版许可是否适用，或由 BytePlus 协助调整；更新包内许可时须同步核对其 SDK AppID，不能用修改服务端播放 Token 有效期来修复域名授权。

用户扫码打开诊断版本 13 后，真机面板确认协议为 HTTPS，完整主机名为 `minis-mn23su3q2uw0yt3p-3v1jv2b9vskjs-3.tiktok-minis.us`。这是 TikTok 托管页面，和当前 API 域名以及自有 License 域名不同。尚未验证其他版本、正式包、其他区域或其他 Mini 的页面域名，因此不能仅针对这一随机主机名签发后就宣称通用上线；也不能将 `tiktok-minis.us` 当作开发者自有根域名。已安装 SDK 1.19.1 从 `window.top.location.hostname` 初始化许可模块；当前面板展示当前页面 `location.hostname`，嵌套页面场景还须核对顶层域名。

2026-10-11 用户提供基础版许可 `l-20322334481-ch-vod-a-1072774.lic`，授权 `*.tiktok-minis.us`，SDK AppID 为 `1072774`。当时按用户要求替换原许可并共用单文件；2026-10-12 已扩展为上表四域名选择。官方播放器仍由宿主提供，不使用这些 Web 许可。已发布且未接入 `mainUrl` 的旧包不会随本次源码修改自动更新。

许可原始 Content 与 Signature 均未修改；选择配置按实际顶层域名在包内生效，四域名所有区域的真机播放仍须通过 SDK 验证。2026-10-12 Plotimo 110 诊断截图分别观察到 Android 的 `tiktokminis.us` 和 iOS 的 `tiktok-minis.us`；EU/COM 按用户要求视为承载域名接入，尚未完成对应真机验收。此前 BytePlus 工单未提交。

Glimora 测试诊断仅通过临时构建产物的只读面板观察页面域名和协议，未加入源码或其他应用。预览版本 13 仅用于取证，不送审、不发布；本地诊断包及其生成脚本已清理，正式修复包从源码重新打包，不含该面板。Sandbox 包使用 `make package-sandbox APP=7694137787536181256`，官方 CLI 校验已通过，解压大小 2.63 MB；此结果不能替代有效 License 的真机播放验收。

make verify 覆盖接口与播放器生命周期的 Vitest 回归、Node 策略/脚本测试、类型与 Web 构建。本轮聚焦回归读取四份真实文件确认域名和 AppID，使用 SDK 测试替身验证原始许可与 mainUrl 传参、创建/切集的日志 AppID、同页初始化、超时/失败重试、未知域名拒绝及错误脱敏，不调用真实云服务。独立 SDK 以单独约 2 MB 的构建块懒加载，正式平台包仍须按目标应用执行 minis build 并验收体积。

上线必须确认目标 AppID 可使用独立 SDK，使用随包基础版许可验证实际页面域名，完成 iOS/Android TikTok 原片播放、广告、授权过期、后台恢复、分享与 reportEvent；普通浏览器成功不能替代容器验收。部署、迁移及回滚见 [实施与上线手册](../../drama-server/docs/veplayer-release-runbook.md)。四份许可的 MainURL 已只读核对：HTTP 200、允许跨域读取，远端 Content/Signature 与本地一致。本轮未执行平台打包、上传、送审、发布或平台配置写入；四域名真机播放和实际续费更新仍待验收。
