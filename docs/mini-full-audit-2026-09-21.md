# Mini 全量代码审查（2026-09-21）

> 后续：用户授权修复后，F01–F12 的实现与回归结果见 [修复记录](mini-audit-fixes-2026-09-21.md)。下文保留审查当时的发现，不作为修复后状态说明。

## 范围与结论

按项目 engineering、player、product-policy、UI、release skills 及 AGENTS.md 完成第一方源码、测试、脚本和配置的逐文件逐行静态审查。覆盖清单见 [逐文件记录](mini-full-audit-2026-09-21-coverage.md)。这不是“所有运行场景均无缺陷”的保证，也不包含第三方依赖源码逐行审查。

基线提交：`e4e556fac49c78509b84ab6918fb207fe8b95772`，加清单中记录的工作区文件版本。审查期间其他工作持续修改播放页、自动解锁及测试，已读取其增量并复测；本次审查未修改业务代码、弹窗样式或文案，未提交、打包、部署或调用真实领奖接口。

确认问题共 12 项（1 项 P1、11 项 P2），按下面编号列出。P1 优先处理身份隔离；P2 按启动/广告播放阻塞、状态恢复、数据展示、诊断顺序处理。未发现可以据当前证据确认的 P0；不等于安全认证。

## 确认问题

### F01 · P1：观看历史没有按 Visitor 隔离

- 位置：`src/runtime/runtime.ts:326`、`:516`；约束：`AGENTS.md`、`README.md`。
- 当前运行时固定使用 `local-device`，登录时还把各 Visitor 分区合并进去；切到另一账号也不替换这个 Store。
- 复现：A 观看并记录进度 → 切换为 B → B 仍读到 A 的历史；身份未完成时 `/library` 也能打开设备分区。
- 影响：共享设备上跨账号暴露历史、收藏和续播位置。现有测试明确断言“切号不清空”，说明测试和书面隔离合同已发生冲突，不是 Store 单元测试能够发现的问题。
- 建议：先明确产品合同；按当前约束恢复应用＋Visitor 分区，冻结旧页 flush 的原 Store，不能继续无条件合并。不要误改已经正确隔离的待领取分区。
- 证据：隔离测试「A 切到 B 后仍然可读 A 的本地历史」。

### F02 · P2：Storage 属性访问失败会在 React 挂载前终止整个应用

- 位置：`src/runtime/runtime.ts:321`、`src/domain/localLibrary.ts:46`、`src/main.tsx:22`。
- 直接求值 `localStorage` 发生在 Store 内部 try/catch 之前。如果 WebView 拒绝 Storage 属性访问，`createRuntime()` 同步抛错，连公开首页和重试 UI 都未挂载。
- 建议：统一安全取得存储对象，失败时使用内存实现并记录脱敏原因；与 `getItem/setItem` 失败分别覆盖。
- 证据：注入抛出 `SecurityError` 的 Storage getter，确认 `createRuntime` 直接失败。

### F03 · P2：启动串行等待全部待领取奖励

- 位置：`src/runtime/runtime.ts:757`、`src/domain/pendingClaims.ts:153`、`src/App.tsx:142`。
- Bootstrap 身份安装完成后仍 `await recoverPendingClaims()`；补领内部逐条 await，App 又等待 bootstrap 兑现才进入播放。
- 影响：两条慢待领会顺序挡住启动；每条 HTTP 超时上限为 15 秒，多个待领可累积几十秒，期间用户停留在启动预览，而非开始当前已获准的播放。
- 建议：身份 ready 与补领完成解耦，补领继续按原账号、原 ClaimID 后台串行恢复；具体依赖未到账权益的剧集继续走正常验权。
- 证据：分别释放两条请求，第二条完成前 bootstrap 始终未兑现。

### F04 · P2：VIP 弹窗旧结算状态覆盖已经到期的权威状态

- 位置：`src/components/VipDialog.tsx:38`。
- `settled` 跨关闭保留；同一 offer 的旧 `active=true` 与当前 global 状态做 OR。服务端或到期计时器已经把 global 改成 false，弹窗仍显示有效；`watch()` 因此直接返回。
- 影响：跨天停留用户无法从此弹窗重新看广告解锁；这不是服务端权益绕过。
- 建议：以最新权威版本及有效期决定 active，规则级进度也按日期/offer/主体失效，不能永久 OR 旧值。
- 证据：完成一次 VIP → 关闭 → 切换为次日 inactive → 重开仍显示 `VIP active today`，没有广告入口。

### F05 · P2：强制 VIP 广告忽略前后台状态

- 位置：`src/components/VipDialog.tsx:94`、`:103`。
- 强制展示 effect 未检查 `visible`，并显式丢弃该参数；后台也会占用 `forcedAttempt` 并调用广告。
- 影响：启动响应在后台返回时可能调用不适合后台展示的桥接，返回前台又没有新的首次尝试。
- 建议：仅在前台且具备展示条件时消费尝试标记；用户要求的前台三秒自动广告行为不需要修改。
- 证据：`open=true, forced=true, visible=false` 仍调用 `watchVIPAd()`。

### F06 · P2：历史仅与公开目录第一页连接，后续页剧目消失

- 位置：`src/pages/LibraryPage.tsx:35`、`src/domain/localLibrary.ts:73`。
- 历史页只取 `limit:20`，不消费 `nextCursor`；`continueWatching()` 丢弃不在这批目录内的本地历史。
- 影响：仍然上线但不在前 20 项的剧目显示不出来；这不能等同于“过滤下架内容”。
- 建议：按历史 ID 获取权威可见摘要，或正确遍历必要分页，保留权限及下架过滤。
- 证据：磁盘有目标历史、第一页未含目标且返回下一页游标，页面仍显示 `No watch history`，只发一次目录请求。

### F07 · P2：一次读取故障清空已知内存历史，且本页不再恢复

- 位置：`src/domain/localLibrary.ts:142`、`:161`。
- 成功读取/写入没有同步 fallback；后续读异常把 `storageUnavailable` 永久置为 true，再返回尚未建立的空 fallback。
- 影响：之前成功显示的历史、收藏突然消失；底层存储恢复后同一个 Store 仍返回空。磁盘旧数据未被本测试删除，不能描述为永久数据丢失。
- 建议：维护最后成功快照，失败降级保留已知记录，并提供受控恢复策略。
- 证据：写入并成功读取一条历史 → getItem 抛错 → 恢复 getItem，后两次历史仍均为空。

### F08 · P2：一次官方切集可以被重复记为两次

- 位置：`src/player/tiktokMinisPlayerEngine.ts:190`、`:340`；消费方 `src/pages/theater/index.tsx` 的 `onSwitchingChange`。
- SDK 的 `PLAY_NEXT_END` 和 `switchSource` finally 都发出 false；页面每次 false 都记录 `player_switch`。
- 影响：当 SDK 同时发事件并兑现 playNext Promise 时，切集指标重复；不能用这些计数评估优化前后切集质量。
- 建议：统一切换状态机，只在状态边沿发布一次，或按切换 revision 去重；失败完成不能算成功切集。
- 证据：替身在 playNext 中发送 END，然后兑现，收到两次 false。

### F09 · P2：关键网络/领奖/存储日志丢失实际错误原因

- 位置：`src/api/httpMiniDramaApi.ts:342`、`src/runtime/runtime.ts:691`、`src/domain/pendingClaims.ts:132`、`src/domain/localLibrary.ts:155`。
- HTTP 网络异常被改写成通用错误，日志只有 errorType；部分领奖分支直接重抛或只打印分类，部分存储 catch 没有错误详情或完全无日志。
- 影响：当前排查“等待、卡住、没有恢复”时无法区分桥接、网络与存储原因；不满足项目的错误日志合同。
- 建议：在负责边界记录 safeErrorMessage，保留原始故障含义但不输出凭据、媒体地址或完整对象；固定英语用户提示不变。
- 证据：注入明确 transport 错误，抛出的错误与日志均不包含该原因，只剩 TypeError/Network request failed。

### F10 · P2：官方 getPlayer 挂起后没有超时或有效重试

- 位置：`src/player/tiktokMinisPlayerAdapter.ts:23`、`:40`。
- 构造器 Promise 仅在 reject 时清除；SDK 永不兑现时永久复用同一挂起 Promise。
- 影响：页面重试无法重新取得构造器，始终不能挂载播放器。SDK 脚本加载超时和 HTTP 超时不能覆盖这个阶段。
- 建议：为获取构造器建立有上限的等待与代次隔离，超时允许重试，忽略旧任务迟到结果；不增加替代播放器。
- 证据：桥接挂起一分钟后再次调用，仍返回原 Promise，实际 getPlayer 只调用一次。此测试证明故障恢复缺口，不证明线上 SDK 必然挂起。

### F11 · P2：SDK 首次失败后重试成功，录屏保护没有重新安装

- 位置：`src/App.tsx:102`。
- 保护 effect 只依赖 runtime，首次 `whenPlatformReady` 失败被吞掉；重试只改变 bootstrapAttempt，导航会重装，保护不会重装。
- 建议：让保护安装参与 SDK 恢复生命周期，并处理同步异常、失败回调及解绑日志；不能仅以 bootstrap 成功推断保护已启用。
- 证据：首次 SDK/启动失败，点击 Retry 后启动成功，`disableCapture` 调用次数仍为零。

### F12 · P2：真实领奖通知顺序仍使连续解锁等待重复详情

- 位置：`src/runtime/runtime.ts:689`、`src/pages/theater/index.tsx:306` 和 `unlockEpisode` 的 knownDetail 读取、`src/pages/theater/useAutoUnlock.ts:47`。
- runtime 在 claimReward 返回前同步 publishEntitlement；页面订阅回调立刻 refreshRewardAccess，清空 fullDetailRef。随后 unlockEpisode 才读取 knownDetail，此时已经是 undefined；自动解锁因此再发一次详情请求并 await。
- 影响：当前集已经获奖，详情慢时仍没有下一广告提示，也没有当前集播放；详情刷新和自动链重复请求。
- 审查期间的外部改动只覆盖“没有权益通知”的测试替身。它通过了新增测试，却没有覆盖真实 runtime 的先通知、后返回顺序。
- 建议：把仅用于集序的稳定目录与需要刷新的权益状态拆开，或在广告开始前冻结合法目录快照；播放许可和后续 offer 仍独立重新校验。不能只在 claimReward 之后、refreshRewardAccess 之前取快照。
- 证据：隔离测试模拟真实同步权益通知，详情请求数增加两次；让详情保持挂起，领奖已经完成，但下一广告弹窗仍不存在。该复现在最新 knownDetail 改动之后通过。

## 播放问题与审查中的变动

1. **进入播放仍会先显示业务封面**：`src/App.tsx:34` 的 PlaybackLaunchPreview 明确如此；它不是官方已渲染的视频首帧。深链不在公开目录前 12 项时还可能没有封面。不能把移除 Opening 文案等同于首帧无等待。
2. **切集重新加回目标封面**：审查期间外部修改为 `transitionCoverRoute` 控制覆盖到实际首帧/续播目标位置。该策略可以遮住空帧，但并不能证明解码或网络等待缩短，也不能满足“完全不先展示封面”的字面要求。本轮没有擅自撤销这项外部改动。
3. **广告后详情串行阻塞**：外部新增测试先失败，后续改为在主动 refreshRewardAccess 前取 knownDetail，并通过了无权益通知的场景。本轮进一步验证真实“同步通知再返回”顺序，仍复现 F12；旧失败日志仅作为过程记录，最终问题依据最新隔离测试。
4. **进度保存不是每帧写盘**：现在为五秒位移阈值、空闲任务或 200ms 延迟；暂停、切集、离页仍同步 flush。同步 getItem/JSON/setItem 可能占用主线程，但未测量其真机耗时，不能断言它就是切集卡顿主因。
5. **三屏动画与切源并行**：VideoSwiper 先触发路由/切源，260ms 后提交视觉集并复位。快切源与慢切源的帧交接都需要真实 SDK 下测量；JS 替身不包含解码、视频合成与网络缓存命中。
6. **排除一个误报**：在真实 Chromium 的 CSS 最小夹具里，`chrome-visible + is-switching` 的 controls/progress/selector opacity 都为 1；高优先级 chrome 选择器覆盖了较弱隐藏规则。未把“切集必然不同步”列为确认问题。此结果不替代广告回程真机验证。

## 风险与维护缺口（不计入确认问题）

- **A→B→A 迟到响应**：HTTP assertIdentity 只比较身份 key，回到 A 后可接收旧 A 的响应；隔离测试已复现。尚未证明它能穿过页面代次防护造成可见污染或越权，因此只列风险。若要保证跨身份历程失效，应增加主体变更 epoch，不能把同主体正常刷新也全部拒绝。
- **依赖告警**：锁文件 Swiper 11.1.1 位于原型污染公告影响范围；公告修复版本为 12.1.2。当前 Swiper 参数是固定 JSX 配置，未发现把外部完整对象展开进选项的路径，未证明 Mini 可被利用。[Swiper 公告](https://github.com/advisories/GHSA-hmx5-qpq5-p643)。React Router 7.18.1 命中 RSC action CSRF 公告，但本项目是浏览器 HashRouter/Vite 静态应用，没有 RSC action 服务；依赖扫描的 high 不能直接定为本项目 high。[React Router 公告](https://github.com/advisories/GHSA-qwww-vcr4-c8h2)。未安装或升级依赖。
- **公开 Logo 有效期**：两个实际应用配置的 logoUrl 使用有期限签名，参数时间分别为 2026-09-16、09-17 UTC，早于审查日。未请求这些地址，不能断言 CDN 当前状态码；建议改成长期可用的公开品牌资源。报告不复制签名地址。
- **本地目录脚本外部写保护不足**：prepare-local-catalog 接受任意 DRAMA_API_BASE_URL，会更新源剧、发布内容和变现配置，没有本地目标限制/明确生产防护。未执行；还需核验它与当前 operations 合同是否一致，不能称已造成生产数据破坏。
- **打包并发隔离**：package-minis 改写共享 minis.config.json/dist，然后 finally 恢复；两个独立进程并发可能互相覆盖。`--all` 自身是串行，不因此构成缺陷。未执行真实打包。
- **测试真实性与维护**：多个 it.each 只剩一个参数，测试体中仍保留不可到达分支；视觉广告夹具没有完整实现真实自动起播和切源；部分导出字段/方法缺少中文合同注释。现有测试不能证明这些未执行分支正确。

## 验证证据与边界

- 隔离复现：13 项全部通过，含上述 F01–F12 和 A→B→A 风险。这里“通过”表示断言成功复现现状，不表示这些行为应保留。
- [隔离测试源码](/tmp/drama-mini-audit.VUZta3/audit.test.tsx)、[运行日志](/tmp/drama-mini-audit.VUZta3/reproductions.log)。临时测试在项目外，没有加入产品测试扫描。
- 首轮 `make verify`：28 个 Vitest 文件/263 项、30 项 Node 测试、类型检查、Web 构建通过。[日志](/tmp/drama-mini-audit-verify.log)。
- 第二轮全量验证同样通过，但随后又出现广告回程测试及实现改动，不能作为这些后续改动的验收。[第二轮日志](/tmp/drama-mini-audit.VUZta3/verify-final.log)。
- 后续新增的广告详情挂起测试有过程失败记录：[原始失败](/tmp/drama-mini-audit.VUZta3/last-external-change.log)、[首次改动后复查](/tmp/drama-mini-audit.VUZta3/last-external-recheck.log)。
- **交付版 `make verify`：28 个文件/264 项 Vitest、30 项 Node 测试、类型检查和 Web 构建通过。** [最终日志](/tmp/drama-mini-audit.VUZta3/verify-delivery.log)。外部新增测试已通过；真实权益通知顺序的 F12 仍由项目外第 13 项复现测试证明。`git diff --check` 通过。
- `npm audit --omit=dev` 返回 3 个受影响包记录（1 critical、2 high），不是三个独立、已确认可利用的产品漏洞。[原始结果](/tmp/drama-mini-audit.VUZta3/dependency-audit.json)。
- Web 构建存在 VITE_API_BASE_URL/VITE_TIKTOK_CLIENT_KEY 未注入警告；这里只证明源码可构建，不代表这个裸 dist 可上传平台。未执行 make package。
- 未执行真实 TikTok iOS/Android 播放、广告、录屏保护、签名打包、线上数据写入，也未用手机镜像作验收。缺少真实首帧延迟、切集帧间隔、预加载命中和长任务采样，因此本报告不宣称卡顿已解决。

## 后续修复顺序

先定本地历史隔离合同并修 F01/F02；然后解除 F03/F12 的启动和广告回程非关键等待；再修 VIP 跨天/可见性与构造器恢复；补齐 F06/F07 数据恢复、F08 指标去重及 F09/F11 诊断/生命周期测试。每项修复先增加期望正确行为的回归测试，再执行 make verify；最终在真实 TikTok 设备对比首帧和连续上下切集，不用增加遮罩代替性能证据。
