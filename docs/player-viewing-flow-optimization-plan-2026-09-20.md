# Mini 播放器与观看链路优化方案

日期：2026-09-20  
范围：`drama-mini` 的播放器、上下切集、续播、预加载、进度、广告解锁、VIP、选集与倍速弹层。本文是代码审查和实施方案，不包含新一轮播放器代码改动。

## 1. 结论

当前实现已经满足 TikTok Minis 的核心合规要求：使用官方 VePlayer、一个播放实例、`playNext` 切集、退出时销毁、MP4 MSE/MMS 能力检测、首页手动预热、播放页 Feed 预加载，以及媒体信息内存缓存。

影响观看流畅度的主要问题已经不在“有没有调用官方播放器”，而在播放器事件、路由、权益和弹窗由多个独立布尔状态驱动。一次切集可能同时经历 Swiper 动画、路由变化、授权请求、封面加载、`playNext`、本地进度 seek、广告、领奖、重新验权和自动解锁提示；目前没有一个控制器定义这些步骤的唯一顺序。因此黑屏、封面缺失、暂停后不恢复和弹窗串联迟滞会随时序变化偶发出现。

建议先把观看链路改成显式状态机，再优化预加载参数。只继续增加遮罩、延时或 `setState` 条件会让竞态更多。

## 2. 官方文档给出的边界

1. TikTok Minis 必须使用官方 VePlayer，不能增加原生 `<video>` 或第三方播放器作为回退。
2. 构造器应缓存；一个页面只保留一个播放器实例，连续剧集使用 `playNext`。
3. `READY` 表示实例已创建，`COMPLETE` 表示媒体元素已建立，`PLAYING` 表示开始或从暂停/缓冲恢复，`TIME_UPDATE` 表示时间变化。`LOAD_START` 不是首帧。
4. 切集还可观察 `PLAY_NEXT_START`、`PLAY_NEXT_END`；拖动和续播可观察 `SEEKING`、`SEEKED`；卡顿可观察 `WAITING`、`STALLED`、`LONG_WAITING`、`OFTEN_WAITING`；自动播放应观察 `AUTOPLAY_PREVENTED` / `AUTOPLAY_FAILED`。
5. Feed 预加载推荐前 1、后 2；首页第一集使用手动模式。播放实例必须启用 `enableMp4MSE` 才能消费 MP4 字节缓存，iOS 17.1+ 依赖 ManagedMediaSource。
6. `setMediaInfoCacheConfig({ enable: true, cacheType: "memory" })` 可复用媒体信息；它与视频字节命中是两件事。
7. 激励广告每个实例只能展示一次，只有 `onClose` 的 `isEnded === true` 才能发奖；关闭、拉取失败、播放失败必须分别验收。官方要求在用户预期获得奖励的合适断点展示。

主要资料：

- https://developers.tiktok.com/docs/en/minis-player
- https://developers.tiktok.com/docs/en/tiktok-minis-in-app-ads
- https://developers.tiktok.com/docs/en/minis-sdk-in-app-ads
- https://docs.byteplus.com/en/docs/byteplus-vod/preloading_web
- https://docs.byteplus.com/en/docs/byteplus-vod/docs-player-sdk-events
- https://docs.byteplus.com/en/docs/byteplus-vod/docs-player-sdk-player-kernel

## 3. 目标观看状态机

播放器只保留一个权威状态：

```text
resolving
  -> access_required -> access_prompt -> native_ad -> claiming -> resolving
  -> preparing -> switching -> restoring_progress -> first_frame
  -> playing <-> user_paused
  -> buffering -> playing
  -> ended -> next_episode(resolving)
  -> failed -> retry(resolving)
```

弹层单独使用一个互斥状态，而不是多个可同时为真的布尔值：

```text
none
episode_sheet       // 软弹层，视频可继续
rate_sheet          // 软弹层，视频可继续
episode_unlock      // 阻断弹层，视频暂停
vip_offer           // 阻断弹层，视频暂停
ad_resume           // 阻断弹层，视频暂停
auto_unlock_offer   // 阻断弹层，视频暂停
native_ad           // 宿主全屏，视频暂停并冻结所有倒计时
```

所有播放恢复只经过一个 `resumeIfAllowed()`：页面在前台、没有阻断弹层、没有原生广告、当前路由和媒体一致、授权仍有效，并且用户在中断前处于播放状态。选集和倍速是软弹层；进入后台时仍要记住打开弹层前的播放意图，回前台后才能正确恢复。

## 4. 逐项代码审查

### P0：直接影响黑屏和观看连续性

#### 4.1 锁定集首图被权益过滤

- 位置：`src/pages/theater/index.tsx` 的 `previewableEpisodeIds`；`src/components/slider-item/index.tsx` 的 `previewable`。
- 现状：`rewarded` 分集在未开通 VIP 时不进入可预览集合，`SliderItem` 因此完全不渲染首图。用户上滑到锁定集时会先看到黑底，再等待广告或锁定 UI。
- 原因：把“是否能看到海报”和“是否能播放媒体”使用了同一权限概念。
- 方案：海报展示只依赖公开/详情接口返回的图片；播放授权仍严格依赖 `resolvePlay`。所有相邻集都展示首图，锁定状态在首图上叠加锁标和明确 CTA，不提前获取或暴露媒体凭据。

#### 4.2 当前集解锁被后续自动解锁流程阻塞

- 位置：`src/pages/theater/index.tsx` 的 `unlockEpisode`，当前把 `refreshRewardAccess()` 与 `autoUnlock.run()` 放入同一个 `Promise.all`，并在两者都结束前保持 `adRunning=true`。
- 现状：用户已经看完当前集广告并完成领奖，仍可能因为后续分集详情、逐集验权、倒计时弹窗或下一条广告而无法恢复当前集。
- 方案：当前集完成广告后只等待本次 claim 和当前集重新验权；一旦可播就立即准备并恢复当前集。批量自动解锁改成脱离关键路径的后续提示，只能在当前集首帧稳定后出现。

#### 4.3 自定义弹窗会自动重新拉起广告

- 位置：`RewardedAdResumeDialog.tsx` 三秒后 `decide(true)`；`AutoUnlockDialog.tsx` 倒计时结束后 `prompt.decide(true)`；`VipDialog.tsx` forced 模式延时后直接 `watch()`。
- 现状：用户主动关闭广告后会被三秒倒计时再次拉起；连续解锁和强制 VIP 也能在没有新点击的情况下启动广告。这既打断观看，也增加宿主拒绝自动展示的风险。
- 方案：倒计时只用于提示或启用按钮，不能自动调用广告 `show()`。所有新广告都由清晰的用户点击触发。提前关闭后回到锁定首图，提供“继续观看广告”和“留在本集”两个可见操作，不用点击遮罩这种隐式取消。

#### 4.4 续播首帧以时间阈值判断，可能永久遮住视频

- 位置：`src/pages/theater/index.tsx` 中 `resumeRevealRef` 要求 `currentTime >= savedTime - 0.25`；`src/player/tiktokMinisPlayerEngine.ts` 未监听 `SEEKED`。
- 现状：关键帧 seek 可能落在目标位置之前超过 0.25 秒，视频已经输出但首图仍不撤；反过来仅收到时间更新也不能证明 seek 后的帧已经合成。
- 方案：续播顺序改为 `READY/COMPLETE -> seek -> SEEKED -> requestVideoFrameCallback -> reveal`。没有帧回调时用 `SEEKED + PLAYING/TIME_UPDATE` 降级，并设置有限超时和明确的测量类型，不依赖精确时间差。

#### 4.5 官方异常和切集事件接入不足

- 位置：`src/platform/tiktok/types.ts` 只声明 10 个事件；`src/player/tiktokMinisPlayerEngine.ts` 只订阅 READY、PAUSE、ENDED、TIME_UPDATE、WAITING、PRELOAD_INFO、PLAYING、ERROR。
- 缺少：`COMPLETE`、`PLAY_NEXT_START/END`、`SEEKING/SEEKED`、`STALLED`、`SOURCE_ERROR/SUCCESS`、`TOKEN_EXPIRED`、`AUTOPLAY_PREVENTED/FAILED`、`LONG_WAITING/OFTEN_WAITING`。
- 影响：切集 Promise 完成、媒体可播放、首帧、卡顿和自动播放失败被压成少数状态，页面只能靠猜测显示封面和 loading。
- 方案：扩展最小类型合同并按用途接入，不需要订阅官方全部事件。以切集事件控制 `switching`，以 seek 事件控制续播，以 waiting/stalled 控制缓冲，以 autoplay 事件展示“点击继续播放/打开声音”。

#### 4.6 质量日志只留在真机控制台

- 位置：`clientLog.ts` 只调用 console；`metrics.ts` 只支持开始、完播和广告计数，没有耗时与卡顿字段。
- 现状：已经记录首帧、预加载命中和卡顿恢复，但无法在运营后台按设备、版本和剧集分析，也无法回答黑屏发生在哪一步。
- 方案：新增脱敏 QoE 批量记录：`player_prepare_ms`、`resolve_ms`、`play_next_ms`、`seek_resume_ms`、`ttff_ms`、`preload_hit`、`preload_bytes`、`stall_count`、`stall_ms`、`autoplay_outcome`、`error_stage/code`、`app_version`、`network_type`。不上传 token、媒体 URL 或原始 SDK 对象。

### P1：高收益的性能和状态一致性优化

#### 4.7 弹层由多个布尔值控制，存在叠层和恢复竞态

- 位置：`TheaterPlayback` 同时持有 `drawerOpen`、`rateSheetOpen`、`vipOpen`、`resumeAdPrompt`、`autoUnlock.prompt`、`adRunning`；各弹层 z-index 分散在 CSS。
- 风险：VIP 条件变化可在其他弹层打开时触发；`EpisodeSheet` 的 z-index 高于 VIP/自动解锁，可能出现两个 `aria-modal` 同时存在且真正的阻断弹层被盖住。
- 方案：使用单一 `overlay` 判别联合和统一 Portal；任何时刻只有一个业务弹层拥有焦点。更高优先级弹层通过队列等待，不能覆盖当前弹层。

#### 4.8 前后台恢复错误地依赖弹层是否打开

- 位置：`index.tsx` 的 `observeVisibility` 在 `drawerOpen` 或 `rateSheetOpen` 时不记录 `resumeRef`，但这两个软弹层本来允许视频继续播放。
- 现象：播放中打开选集或倍速，再切后台，回来后视频可能一直暂停。
- 方案：在任何系统中断前独立记录 `wasPlayingBeforeSystemInterruption`；不要用当前弹层布尔值反推用户意图。回前台先重新验权，再由统一恢复函数决定是否播放。

#### 4.9 全部分集都创建 SwiperSlide

- 位置：`video-swiper/index.tsx` 对 `episodes.map` 全量渲染，只把海报限制在附近两集。
- 影响：长剧仍会创建几十到上百个 slide、section、host ref 和 Swiper 节点；切集时布局与 transform 成本随集数增长。
- 方案：使用 Swiper Virtual，或只维护前一集、当前集、后一集三个物理 slide，并保持同一个播放器根节点。选集面板继续保留完整目录。

#### 4.10 业务验权预取窗口大于官方播放窗口

- 位置：`index.tsx` 当前对 `[current-1, current+3]` 并发调用 `resolvePlay`；官方 Feed 字节预加载配置是前 1 后 2。
- 影响：每次切集可能多取一个短期授权，并与当前媒体起播争用 API；TikTok 也建议临近需要播放时再取有限期凭据。
- 方案：默认只验权前 1 后 2，优先级为当前目标、下一集、上一集、下下集；网络差或当前播放器 `readyState < HAVE_FUTURE_DATA` 时暂停非当前验权/预加载。不要在切集过程中不断清除已下载字节。

#### 4.11 播放器准备在首页关键请求同时启动

- 位置：`App.tsx` 在 bootstrap 开始时立即调用 `preparePlayback()`。
- 影响：冷启动时 `getPlayer`、预加载模块、公开接口和封面同时争用主线程与网络。官方要求缓存构造器，但没有要求它必须早于首页内容。
- 方案：首页先完成首屏接口与主封面；随后用空闲任务准备播放器。卡片进入高可见区或 pointerdown 时立即提升优先级。深链播放仍立即准备，不等待首页。

#### 4.12 海报没有复用首页图片资源层

- 位置：`predecodePoster` 直接创建 `Image`，`SliderItem` 和 `player-transition-poster` 使用原始 URL。
- 影响：全尺寸图片解码会增加 iPhone 内存和切集抖动；路由快速变化时旧图仍可能继续下载/解码。
- 方案：为播放器增加 720/设备宽度封面档位，复用共享加载器的去重、取消和失败回退；只保持当前、前一、后二的解码资源，切剧立即释放。签名 URL 继续禁止改写。

#### 4.13 所有 WAITING 都用整张海报覆盖

- 位置：`bufferingRoute` 一进入 WAITING 就显示 `player-transition-poster`。
- 影响：能避免黑屏，但播放到一半短暂抖动也会闪回剧集封面，用户会感觉视频重启。
- 方案：初始起播、切集和续播阶段立即保留首图；播放中卡顿先保留最后视频帧并在 150–300ms 后显示小型缓冲提示。只有 `readyState < HAVE_CURRENT_DATA` 持续较久或播放器实际暴露黑底时才升级为海报遮罩。

#### 4.14 快速连续切集仍会排队

- 位置：`TikTokMinisPlayerEngine.switchQueue` 不能取消正在执行的 `playNext`，后续目标只能等待；Swiper 在动画结束后才导航。
- 方案：页面切集期间只接受一个后续意图并覆盖旧的待执行目标；正在执行时禁用再次提交但仍允许手势回弹。首图跟随最终目标，`playNext` 完成后直接执行最新目标，不逐个播放所有中间集。记录 coalesced 次数验证用户是否频繁触发。

### P2：体验完整性

#### 4.15 自动播放降级后没有声音恢复入口

- 位置：播放器开启 `enableDegradeMuteAutoplay`，同时忽略 volume 插件，页面没有 unmute 状态。
- 方案：监听自动播放失败/静音降级；展示一次明确的“点击播放并打开声音”按钮。用户手势成功后再进入自动隐藏控制栏。

#### 4.16 720p 被硬编码

- 位置：`officialPlayerOptions.defaultDefinition = "720p"`，预加载也复用同一配置，所以当前缓存键是一致的。
- 处理：先读取实际媒资清晰度和缓冲指标。如果后台只有 720p，保留；如果返回多档并支持 ABR，再基于官方能力开放 auto/清晰度选择。不能只为了“更流畅”直接删值，否则可能让媒体信息缓存和预加载命中失效。

#### 4.17 弹层生命周期和可访问性不统一

- `VipDialog` 没有与其他弹层一致的焦点进入、焦点循环和退出恢复。
- VIP 内部续播弹层使用 `document.visibilityState`，没有使用 TikTok Minis 的 show/hide 合并状态，宿主隐藏但 DOM 仍 visible 时倒计时可能继续。
- `theater-content` 在选集弹层打开时没有 inert；后台控件仍可能被辅助技术访问。
- 错误、settled 和倒计时状态需要在新 offer/新 route 时统一复位，不能从上一次弹窗泄漏。

## 5. 弹窗与播放器的推荐串联

### 用户滑到可播放分集

1. 手势开始时只提升目标海报和授权预取优先级。
2. 动画完成后提交目标路由，首图已经可见。
3. 命中授权缓存后调用一次 `playNext`。
4. 等 `PLAY_NEXT_END/COMPLETE`；有历史则 seek 并等待 `SEEKED`。
5. 收到实际帧后原子撤掉首图；视频开始后再隐藏 loading。

### 用户滑到锁定分集

1. 先显示该集首图和锁定标识，不出现黑底。
2. 暂停旧集并清除旧进度目标，不销毁播放器。
3. 展示一个解锁面板，用户点击后才创建并展示本次广告实例。
4. 广告关闭：未看完则回到同一个锁定面板；看完则 claim。
5. claim 成功后只重新验权当前集，预热当前媒体，然后 `playNext`。
6. 当前集首帧出现后才允许展示“是否继续解锁后续”的轻提示；拒绝不影响当前观看。

### VIP 投放

1. 若必须展示，先排队等待选集/倍速面板关闭。
2. 弹窗只解释权益和进度；广告由按钮点击发起。
3. 每看完一条广告，后台状态成功后在原弹窗更新进度；达到目标立即关闭并恢复当前集。
4. 关闭 forced 弹窗只更新本次启动的展示次数，不自动再弹或立刻重新验权多次。

### 后台和原生广告回程

1. 中断前保存用户播放意图和最终进度。
2. 冻结所有自定义倒计时。
3. 回前台先检查当前路由和授权；不要同时由 `visibilitychange`、`minis.show`、广告 close 三条路径各自调用 play。
4. 统一控制器只恢复一次；如果用户中断前手动暂停，则保持暂停。

## 6. 观测与验收标准

每次观看会话生成本地 session id，每一集生成 route revision；所有事件携带 revision，迟到事件直接丢弃。后台至少能查看：

| 指标 | 验收用途 |
| --- | --- |
| 入口点击到首图 | 页面和图片是否及时响应 |
| 入口点击到首帧 TTFF | 首次播放性能 |
| 滑动结束到首帧 | 切集性能 |
| `playNext` 开始/结束耗时 | SDK 切源与业务等待拆分 |
| 续播 seek 到 seeked/首帧 | 续播遮罩是否准确 |
| 预加载 hit、duration、bytes | 预加载是否真正参与起播 |
| stall 次数、总时长、最长时长 | 播放流畅度 |
| autoplay prevented/muted | 是否需要用户手势入口 |
| 弹窗出现、点击、取消、广告完成、claim、恢复首帧 | 广告链路每一步转化与耗时 |

真机必须覆盖 iPhone 支持 MMS 与不支持/不命中字节预加载的路径，并分别测试：首次进入、历史续播、连续上下切 10 次、快速反向切集、锁集完成广告、广告中途关闭、广告拉取失败、VIP 未完成/完成、弹层打开时切后台、手动暂停后切后台、进度拖动后切集、弱网卡顿、最后一集、100 集长剧。

目标建议先以可观测基线校准，再设阈值。第一阶段可用：首图无黑底率 100%；弹窗互斥率 100%；错误路由事件应用率 0%；预加载命中时切集首帧 P75 小于 500ms；未命中时 P75 小于 1.5s；每次广告完成到当前集恢复首帧 P75 小于 1.5s。

## 7. 推荐实施顺序

1. **状态机与观测**：增加 route revision、播放器事件、QoE 批量记录和单一 overlay；先获得真实基线。
2. **首图与切集**：解除锁集海报过滤，使用 `PLAY_NEXT/SEEKED/帧回调` 驱动遮罩，合并快速切集意图。
3. **广告和弹窗**：当前集优先恢复，取消所有自动拉起广告，统一软弹层/阻断弹层/原生广告的暂停恢复。
4. **预加载与资源**：验权窗口收敛到前 1 后 2，播放器准备延后到首屏后，海报接入共享资源层。
5. **长剧性能**：Swiper 虚拟化或三页窗口，减少 DOM 和 ref。
6. **参数实验**：基于真机命中率与卡顿数据比较 preloadTime 3/5 秒、缓存数量和清晰度策略，不凭感觉调整。

每一步都应保持官方单实例和 `playNext` 结构；无需重写播放器，也不引入另一套内核。
