# 官方播放器文档核对与 Mini 加载方案

首次核对：2026-09-20。最近复核：2026-09-21。状态：官方 API 本地参考与实现审查记录。

本文先列依据和 API，再提出方案。范围是 TikTok Minis 提供的 BytePlus Web VePlayer，包括初始化、播控、事件、媒体信息、预加载、清晰度、HLS、字幕、音轨、插件和生命周期；不把 Android/iOS 原生 SDK API 当成 H5 可调用能力。

## 1. 来源、覆盖范围与缺口

### 首要依据

- [TikTok Minis Player 官方公开文档](https://developers.tiktok.com/docs/en/minis-player)：2026-09-21 复核，页面标注最后更新于 2026-08-04；公开说明覆盖构造、`playNext(options)`、事件、字幕和首帧预加载。
- [TikTok 短剧播放器接入指南（官方原地址）](https://bytedance.larkoffice.com/wiki/B9J3wtpntir3PfkTwY3cSkGwnib)。本次原地址未能直接取得正文；已读取仓库中的中英文导出正文和附件 Demo，不声称已核实在线最新版本。
- [本地官方导出目录](../../drama-docs/官方对接文档/)：主指南包含基础播控、字幕、媒体信息预请求、MP4 字节预加载、转码、多清晰度、HLS Master/ABR、多音轨和错误说明。
- 同目录《短剧媒资库和播放器接入说明》核对平台播控、审核、上架、账号绑定规则；《TikTok Minis 短剧小程序接入方案 - BytePlus VOD》提供服务与播放端边界。
- [Minis 技术形态说明](../../drama-docs/TikTok%20Minis%20技术形态说明.md)、[JS API 说明](../../drama-docs/TikTok%20Minis%20JS%20API%20说明文档.md)：用于区分宿主启动、SDK 初始化、业务脚本、登录和页面生命周期。
- 主指南附件 `tiktok-minis-drama-demo.zip`：核对 best-practice、sdk、preload、playback-config、playback、types、config 和 useMinisPlayer。Demo 是实现示例，不能覆盖指南约束，也不能将其 mock、测试 SDK 地址带入项目。

### 已检索的 BytePlus 官方文档

| 官方页面 | 本次核对状态 / 用途 |
| --- | --- |
| [配置参数](https://docs.byteplus.com/en/docs/byteplus-vod/docs-web-api-reference) | 已读参数表；区分初始化参数与运行时方法 |
| [播放器内核](https://docs.byteplus.com/en/docs/byteplus-vod/docs-player-sdk-player-kernel) | 已读属性、状态、方法 |
| [事件](https://docs.byteplus.com/en/docs/byteplus-vod/docs-player-sdk-events) | 已读媒体、SDK、插件事件 |
| [插件](https://docs.byteplus.com/en/docs/byteplus-vod/docs-plugins-web) | 已核对插件配置、播放列表方法、基础插件生命周期及事件接口 |
| [自定义 UI](https://docs.byteplus.com/en/docs/byteplus-vod/docs-custom-ui-web) | 已读；区分皮肤、插件和业务覆盖层 |
| [动态缓冲](https://docs.byteplus.com/en/docs/byteplus-vod/dynamic_buffer_web) | 已读；作用于正在播放的媒体 |
| [ABR](https://docs.byteplus.com/en/docs/byteplus-vod/abr_streaming_web) | 已读；不能把独立流列表与 HLS Master 内部档位混为一谈 |
| [版本记录](https://docs.byteplus.com/en/docs/byteplus-vod/docs-release-notes-web-player) | 已读；独立 Web SDK 版本不等于 Minis 内置版本 |
| [兼容性](https://docs.byteplus.com/en/docs/byteplus-vod/docs-web-player-sdk-compatibility) | 已读；较旧概览与 Minis 新增 MMS 能力存在时间差 |
| [快速开始](https://docs.byteplus.com/en/docs/byteplus-vod/docs-getting-started-with-the-web-player-sdk) | 已取得；独立接入说明不能替代 TTMinis.getPlayer |
| [HLS 与标准加密](https://docs.byteplus.com/en/docs/byteplus-vod/playing_hls_standard_encrypted_videos_web_new) | 核对格式、CORS、加密接入边界 |
| [DRM](https://docs.byteplus.com/en/docs/byteplus-vod/playing_drm_encrypted_videos_web) | 核对资源与平台前提；不作为当前项目回退链路 |
| [私有加密](https://docs.byteplus.com/en/docs/byteplus-vod/playing_private_encrypted_videos_web) | 核对 generateEncryptInfo；当前不引入独立取证流程 |
| [DASH](https://docs.byteplus.com/en/docs/byteplus-vod/playing_dash_videos_web) | 已读；不作为本次移动端加载优化目标 |
| [错误码](https://docs.byteplus.com/en/docs/byteplus-vod/docs-error-code) | 核对 Web 错误及错误分层；页面还混有原生 SDK 错误，不全部照搬 |
| [方法](https://docs.byteplus.com/en/docs/byteplus-vod/docs-web-methods) | 未取得正文；搜索及浏览器补查仍未解决 |
| [类型定义](https://docs.byteplus.com/en/docs/byteplus-vod/docs-web-type-definitions) | 未取得有效正文 |
| [预加载](https://docs.byteplus.com/en/docs/byteplus-vod/preloading_web) | 未取得有效正文；本次依据 Minis 主指南的完整专章 |
| [多音轨](https://docs.byteplus.com/en/docs/byteplus-vod/docs-multi-audio-track-web) | 未取得有效正文；本次依据 Minis 主指南的完整专章 |
| [基础功能](https://docs.byteplus.com/en/docs/byteplus-vod/docs-implementing-basic-features-web) | 未取得有效正文；由主指南、内核、配置、事件文档交叉核对 |

不能据此声称“官网所有页面、所有版本 API 均已完整核实”。以下清单覆盖已取得文档公开说明的主要调用面；未明确的签名、返回值或版本，不自行补成确定事实。

## 2. SDK 和播放器对象的边界

1. `TTMinis.init(...)`：先建立 Minis 桥接环境。SDK 初始化失败和业务登录失败是不同故障。
2. `TTMinis.getPlayer("byteplus")`：异步取得平台提供的构造器；缓存进行中的 Promise 和成功结果。主指南的某些示例省略参数，本项目按既有明确参数调用。
3. `VePlayer` 构造器：提供静态媒体查询、缓存和预加载能力。取得构造器不等于已经建立播放器实例。
4. `new VePlayer(options)`：挂载某一集的播放器。内核异步生成，等待 `READY` 后访问 `instance.player`。
5. `instance.player`：实际播控内核；不能和 SDK 包装实例、全局预加载器混用。

唯一生产播放入口仍是平台官方播放器。通用文档中的 npm/CDN 独立 VePlayer、DirectUrl、`Service.url(token)`、旧版播放 Token 与独立 License 示例，不纳入本项目播放流程。平台官方播放器内部选择原生媒体内核，与业务自建原生 video 回退是两件事。

## 3. 初始化与媒体参数

| 参数 / 回调 | 说明与设计约束 |
| --- | --- |
| `id` / `root` | 绑定稳定的播放器容器；不能在切集时反复替换根节点 |
| `albumId`、`episodeId` | 平台剧、集标识，使用字符串；来自 API 权益校验结果 |
| `vid` | 建议传入；自动预加载按 vid 定位，必须与目标集一致 |
| `width`、`height`、`videoFillMode` | 设置尺寸与填充方式；不能把 poster 的枚举当成视频枚举 |
| `autoplay`、`autoplayMuted`、`muted`、`playsinline` | 播放意图和移动端行为；配置不保证自动播放成功 |
| `startTime` / 续播相关配置 | 从本地记录取得起点，但记录不授予播放权益；具体切集参数沿项目已有适配器核对 |
| `defaultDefinition` | 在已返回的流中选默认档位；不会让服务端凭空生成该档，也不是 Master 内部 level 锁定 |
| `transcodeParam` | 请求哪类媒体产物；预请求、字节预热、正式播放保持一致 |
| `enableMp4MSE` | MP4 字节缓存参与播放的必要配置；还必须具备实际运行能力和兼容资源 |
| `enableMobileHlsPlugin` | 在支持 MSE/MMS 的移动端选择 HLS 插件路径；不等于 MP4 预加载开关 |
| `adaptRange` | 当前视频的动态缓冲范围；不是“下一集预热多少秒” |
| `poster` | 起播前视觉承接；隐藏条件不能误用开始加载事件 |
| `onGetMediaInfo(data)` | 查询或缓存命中都会回调，可能早于 READY；只证明媒体信息就绪，不证明下载或出画 |
| `controls`、`ignores`、`plugins`、`panel` | 控制原有 UI / 插件；只接入产品需要的功能，避免两套菜单和进度控制 |
| `memoryPlay` | SDK 自带续播机制；项目已有本地进度所有者，不再开启一套竞争存储 |
| `oriErrRetry*`、`sdkErrorPlugin` 等 | SDK 自身存在恢复机制；业务不能叠加无限重建或多层无上限重试 |
| `onMediaExpired` / `onTokenExpired` | 通用 SDK 资源刷新回调；当前项目不据此新增旧 Token 或 DirectUrl 回退 |

`transcodeParam` 字段均为可选字符串：`format`（mp4/hls）、`codec`（H264/H265）、`definition`（筛选清晰度或 auto）、`fileType`、`needThumbs`、`needBarrageMask`、`unionInfo`、`quality`、`drmKek`、`jsPlayer`。后四类加密/音频等字段仅在对应功能中使用，不为“优化”盲目填入。

区别：不传 `transcodeParam.definition` 可以得到匹配条件下多个产物；指定某一档通常只返回该档或降级结果。`defaultDefinition` 是在返回结果中选择。配置与实际返回格式都要记录为脱敏诊断字段。

## 4. 静态 API：媒体信息与预加载

| API | 参数、结果与时机 |
| --- | --- |
| `prefetchMediaInfo(sources)` | SDK init/getPlayer 后即可调用，不需实例或 prepare；source 含 albumId/episodeId，可带 vid/defaultDefinition/transcodeParam。返回与输入顺序对应的逐项 fulfilled/rejected 结果；成功含 data/fromCache，失败含 error |
| `setMediaInfoCacheConfig(config)` | 设置 enable、cacheType、expireTime、maxEntries；主指南默认自动缓存关闭、memory、30 分钟、100 条。实际有效期受媒体 URL 到期时间约束 |
| `clearMediaInfoCache()` | 清媒体信息缓存；不会代替字节和任务清理 |
| `prepare({strategies:{preload:...}})` | 先初始化预加载模块；传 true 使用默认值，也可配对象。异步等待自身完成，不让它成为首页展示的条件 |
| `setPreloadScene(scene, options)` | 0 普通手动模式、1 Feed 自动模式；改变模式会清待列表，但不保证取消已在途任务 |
| `setPreloadList(sources)` | 替换列表；自身先解析媒体信息再预加载字节，前面无需紧接着重复 prefetchMediaInfo |
| `addPreloadList(sources)` | 向列表追加；自动模式必须保持播放顺序，不能将不同业务候选随意混入 |
| `preloader.clearPreloadList()` | 清待处理列表；不取消已在途加载、不释放已下载字节 |
| `preloader.removeAllPreloadTask()` | 取消在途/待处理任务；不是清空所有已下载缓存的同义词 |
| `preloader.removeAll()` | 释放已下载字节；不会自动取消仍可能继续写缓存的任务 |

关键语义：

- `prefetchMediaInfo` 仅取媒体信息，不下载视频。显式调用即使未开启自动媒体缓存也会写独立内存缓存；相同标识的并发查询可复用，失败后允许再次请求。
- 媒体缓存不是业务权益缓存。API 判定锁集或不可播时，不能因为 SDK 有缓存就继续播放。
- 普通模式：业务给出的每个候选都会进入预热，应限制候选数量。自动模式：列表定义顺序，SDK 以当前 vid 定位前后集，逐条加载并在当前播放缓冲不足时让位。
- 当前指南字节预加载只支持 MP4。MSE/MMS 存在、资源兼容且正式播放启用 MP4 MSE 才可能命中。只有原生播放路径时继续使用官方播放器，允许只做媒体信息预请求。
- 默认配置：`prevCount=1`、`nextCount=2`、`preloadTime=5` 秒、`preloadMaxCacheCount=15`、`disabled=false`。这些是文档默认值，不是本项目性能结论。
- 同一剧不能只用 dramaId 作为媒体缓存键。业务复用至少区分应用/环境、剧、集、资源版本、清晰度、转码参数；SDK 自己的缓存细节不由业务猜测重写。

### 命中证据

| 观察项 | 能证明什么 |
| --- | --- |
| `onGetMediaInfo.fromCache` | 媒体查询结果复用；不是视频字节命中 |
| `instance.preLoadData.hit` | 是否使用预加载数据起播；配合 duration（秒）、length（字节） |
| `PRELOAD_INFO` | SDK 发现可用预加载缓存；检查 byteLength 等有效数据，不能只数事件 |
| `PLAYING` | 播放已开始/恢复；用于播放状态，不等于精确显示时间戳 |
| 实际帧回调 / 官方可用的首帧指标 | 用于更精确的出画度量；指标字段必须先核对实际版本 |

## 5. 包装实例与内核 API

### Minis 已明确的包装实例接口

| API | 用途与约束 |
| --- | --- |
| `on(event, callback)` | 绑定事件；回调需要绑定当前播放会话，清理时保留同一函数引用 |
| `once(event, callback)` | 单次监听；不能用于需要每集重复响应的事件 |
| `off(event, callback)` | 解绑对应监听，路由离开与切集防止旧回调污染新状态 |
| `playNext(options)` | 复用实例切源；传新集标识及一致媒体参数。当前 TikTok 官方公开示例只传一个 options 参数，且没有要求切换前主动 pause；Promise 完成与真实起播分开 |
| `destroy()` | 销毁包装实例、释放引用；页面卸载只让一个所有者调用，随后禁止再调用旧对象 |
| `getDefinitionList()` | READY 后读取实际返回的独立清晰度列表 |
| `changeDefinition(definition)` | 只选列表内档位；通过 DEFINITION_CHANGE 确认，不能伪造未返回清晰度 |

### 内核 API 索引

以下是通用内核的调用面。Minis 业务使用前仍需检查包装是否暴露，尤其是通用文档未承诺的扩展。完整签名以[官方内核页](https://docs.byteplus.com/en/docs/byteplus-vod/docs-player-sdk-player-kernel)为准。

| 接口 | 作用 |
| --- | --- |
| `play()` / `pause()` | 播放 / 暂停；play 处理 Promise 拒绝及可能的空返回 |
| `replay()` / `seek(seconds)` | 重播 / 定位；进度操作与播放状态需分别管理 |
| `reload()` | 重载当前媒体 |
| `resetState()` / `reset()` | 重置状态 / 同时重置配置与插件；不用于普通切集 |
| `start(url)` / `setConfig(config)` | 启动 / 更新配置；禁止用于注入外部播放 URL |
| `destroy()` | 内核释放；通常由包装销毁统一负责 |
| `focus(options)` / `blur(options)` | 控制播放器 UI 活跃状态 |
| `canPlayType(mime)` | 格式能力查询 |
| `getBufferedRange(buffered?)` / `checkBuffer(time)` | 当前缓冲区间 / 时间点是否已缓冲 |
| `getFullscreen()` / `exitFullscreen()` | 全屏操作，具体进入语义以实际实现核实 |
| `getCssFullscreen()` / `exitCssFullscreen()` | 页面全屏操作；不能当成系统全屏 |
| `resize()` | 重新计算尺寸 |
| `addClass` / `removeClass` / `hasClass` / `setAttribute` | 容器样式与属性 |
| `getPlugin` / `registerPlugin` / `unRegisterPlugin` | 获取、注册、卸载插件 |

内核可观察属性包括 currentTime、duration、buffered、played、paused、ended、volume、muted、playbackRate、state、readyState、networkState、error。只读状态不写入；音量/速度设置要服从真实移动端能力。`src/currentSrc` 不作为业务切源入口。

## 6. HLS 与 ABR API

来源：主指南 HLS 专章。只有 HLS Master 具备相应轨道且实际内核支持时才开放菜单；不将普通 HLS 和 MP4 无条件切换为此路径。

| API | 参数 / 返回 / 完成条件 |
| --- | --- |
| `getHlsLevels()` | 返回本会话 level 列表；manifest 未就绪或非对应内核可为空 |
| `getHlsLevelState()` | 返回 ready、levels、current/load/next/manualLevel、autoLevelEnabled、capping、playbackSessionId |
| `setHlsLevel(index, options?)` | 返回 void；提交手动切档，可能同步抛错；options 含 mode 和 playbackSessionId，通过 HLS_LEVEL_SWITCHED 确认 |
| `getHlsAbrState()` | 返回实际播放/ABR 引擎、模式、可用性、原因、capabilities；先检查再调用 |
| `setHlsAbrMode('auto'|'manual')` | auto 恢复自动；manual 停止自动但不指定具体档位 |
| `getHlsAbrLimit()` | 获取上限对象，没有时 null |
| `setHlsAbrLimit(limit|null)` | 设置或清除上限；level/bitrate/definition 必须符合 capabilities；错误同步抛出，原上限保留 |

`setHlsLevel` 模式：next-fragment 默认随下一分片切换；smooth 保留已有缓冲，画面可能稍后变化；immediate 可能短暂停顿。不要 `await void` 后就宣布画质已生效。

level 对象可含 index、bitrate、averageBitrate、宽高、帧率、音视频编码；不暴露鉴权地址。索引仅当前会话有效。码率单位 bit/s。

`startLevel` 只决定起播，不锁清晰度。`autoBitrateOpts.enable=false` 不等于关闭底层 hls.js 自适应；自动档与实际引擎分开记录。设置 ABR 上限也不会自动退出手动档。

事件：HLS_LEVELS_UPDATED、HLS_LEVEL_SWITCHING、HLS_LEVEL_SWITCHED、HLS_ABR_ENGINE_RESOLVED、HLS_ABR_STATE_CHANGE、HLS_ABR_LIMIT_CHANGE。处理前检查 playbackSessionId。

## 7. 字幕 API

来源：主指南字幕专章。先注册 `Subtitle`。`autoSubtitle` 解析媒资字幕；`formatAutoSubtitleItem` 是同步格式化回调，可改标签/排序/默认项或隐藏。`Subtitle.style` 是对象替换语义，不默认深合并。

| API | 用途 / 结果 |
| --- | --- |
| `getSubtitleList()` | 返回当前列表；未就绪/插件不可用可能为空，不能立刻断言没有字幕 |
| `switchSubtitle({id|language})` | 优先 id；只按 language 必须唯一匹配，异步成功/失败；切集后重读列表 |
| `showSubtitle()` | 恢复之前选择，无选择时使用第一条 |
| `hideSubtitle()` | 隐藏但保留数据 |

自动解析字幕会影响配置列表；非空外挂 list 优先于 Master 字幕。使用 Master 字幕须符合对应初始化条件，不把三种来源同时开启后期待自动合并。

HLS_SUBTITLE_TRACKS_UPDATED、HLS_SUBTITLE_TRACK_SWITCHING、HLS_SUBTITLE_TRACK_SWITCHED 分别对应列表、提交、生效；事件含会话信息。字幕 ID 不跨集复用；原始 text/label 不保证已完成 UI 格式化。

## 8. 多音轨 API

来源：主指南多音轨专章。需要已有多音轨 HLS Master，设置 format=hls 本身不会生成音轨。

| API | 用途 / 结果 |
| --- | --- |
| `getAudioTracks()` | 当前完整列表；单音轨/尚未就绪可能为空 |
| `getCurrentAudioTrack()` | 当前项或 null |
| `switchAudioTrack(track)` | 传当前列表中的完整对象，返回 void；字段不匹配可能静默忽略；以 AUDIO_TRACK_CHANGE 确认 |

AudioTrackInfo 含 id、name、default、selected，可含 lang、assocLang、characteristics、channels、audioCodec、groupId。`audioPreference` 多字段共同匹配，语言大小写不敏感；无匹配时回到清单默认。

首次读取等待 AUDIO_TRACKS_UPDATED；切源后重新读取。手动音轨选择与清晰度切换、playNext 的保留规则不同，主指南说明切集会清除手动选择。Android 多音轨通常需 HLS 插件和 MSE；iOS 原生及 iOS 17.1+ MMS 路径分别验收。

## 9. 插件、自定义 UI 与事件覆盖

插件 API 索引（[官方说明](https://docs.byteplus.com/en/docs/byteplus-vod/docs-plugins-web)）：

- 生命周期：beforeCreate、afterCreate、beforePlayerInit、onPluginsReady、afterPlayerInit、destroy；异步初始化错误不得挂住播放。
- 事件：on、once、off、offAll、emit、emitUserAction；移除监听使用原函数。
- UI：show、hide、find、bind、unbind、setStyle、setAttr、setHtml；卸载清理 DOM 代理。
- 播放列表插件：next、prev、changeList、setIndex。其首尾循环行为不能替代短剧权益控制和最后一集规则。
- Demo 的 progress.useHooks：dragstart、drag、dragend；返回 true 保留默认 seek。仅 Demo 有用法，版本暴露情况需实测。

事件清单按[官方事件页](https://docs.byteplus.com/en/docs/byteplus-vod/docs-player-sdk-events)核对，避免将不同阶段当成同一种成功：

| 分类 | 已核对名称 |
| --- | --- |
| 加载与媒体状态 | ABORT、CANPLAY、CANPLAY_THROUGH、DURATION_CHANGE、EMPTIED、ENDED、ERROR、LOADED_DATA、LOADED_META_DATA、LOAD_START、PROGRESS、STALLED、SUSPEND、WAITING |
| 播控 | PAUSE、PLAY、PLAYING、RATE_CHANGE、SEEKED、SEEKING、TIME_UPDATE、VOLUME_CHANGE |
| SDK 生命周期 | READY、COMPLETE、PLAYER_CREATED_FINISH、PLAYER_REBUILD、DESTROY、RESET、REPLAY、RETRY、PLAYNEXT |
| 资源与解码 | URL_CHANGE、URL_NULL、SOURCE_ERROR、SOURCE_SUCCESS、TOKEN_EXPIRED、UMD_LOAD_FAIL、NOT_SUPPORT_HARDWARE_DECODER、NOT_SUPPORT_SOFT_DECODER、LICENSE_STATUS_WARNING |
| UI | PLAYER_FOCUS、PLAYER_BLUR、FULLSCREEN_CHANGE、CSS_FULLSCREEN_CHANGE、MINI_STATE_CHANGE、VIDEO_RESIZE、PIP_CHANGE、ROTATE、SHORTCUT、USER_ACTION、LEAVE_PLAYER、ENTER_PLAYER |
| 质量与自动播放 | DEFINITION_CHANGE、AUTOPLAY_STARTED、AUTOPLAY_PREVENTED、AUTOPLAY_SUCCESS、AUTOPLAY_FAILED、LONG_WAITING、OFTEN_WAITING、DEFINITION_DEMOTE、INNER_DEFINITION_CHANGE、LINE_CHANGE、ABR_AUTO_DESC_CHANGE |
| 插件扩展 | DANMU_CHANGE、CANCEL_UNMUTE、REFRESH_CLICK、PLAY_BACKUP_CHANGE、PLAY_BACKUP_CHANGE_FINISH、PLAY_ERROR_BUTTON_CLICK、PlAY_URL_CHANGE、SHOW_PLAY_ERROR、GET_PLAY_URL_ERR、MEDIA_EXPIRED、MIRROR_CHANGE、TIME_SCALE_CHANGE、MUSIC_MODE_CHANGE、MUSIC_CHANGE、MUSIC_LIST_CHANGE、MENU_LOG、MENU_REPORT、PLAY_LIST_CHANGE、PLAY_LIST_ITEM_CHANGE、PLAY_NEXT_START、PLAY_NEXT_END、CORE_EVENT |

EMPITED、SEI_PARSED 标为废弃，不新增依赖。音轨、字幕、HLS 和 PRELOAD_INFO 的含义见上文。插件事件的参数并非都在通用页面详细定义；无说明的 payload 不自行解构为确定字段。

本项目实际订阅集中于：就绪、播放/暂停、实际帧、时间/拖动、缓冲、结束、错误、预加载命中和需要的功能事件；不为“覆盖所有 API”把所有插件装入线上。

## 10. 文档冲突和实施前必须确认的内容

| 问题 | 处理结论 |
| --- | --- |
| 主指南将 LOAD_START 写成首帧，通用事件页是开始加载，Demo 使用 PLAYING 后帧回调 | 不用 LOAD_START 隐藏封面或报告已出画。当前代码已用 PLAYING/时间推进，但仍是估计；新增精确指标必须注明测量方式 |
| 通用 preload 类型提到 hls，而 Minis 专章仅支持 MP4 字节预加载 | 本方案只按已确认 MP4 能力设计字节缓存；HLS 不承诺此命中 |
| 较旧兼容表说 iOS 缺 MSE，新 Minis 文档加入 iOS 17.1+ MMS | 检测运行能力及资源；真机校验，而非只比较系统版本 |
| 旧段落写服务端暂不支持多清晰度，新专章提供完整方法 | 新能力以实际返回与当前 Minis SDK 为准，不能依据旧段落永久关闭 |
| Demo 配置与说明的填充模式、缓冲数值不同 | 不复制未经确认的枚举；参数设为可调整实验值 |
| getFullscreen、blur 等通用描述与命名/例子存在歧义 | 本轮不改这些接口；需要时先做最小真机验证 |
| Demo 与主指南对部分可选参数契约不完整 | 不凭示例推断全部返回、取消和幂等语义 |
| 部分方法/类型在线正文不可用 | 保留缺口，缺失契约不得成为关键路径依赖 |

仍须通过实际平台确认：内置播放器版本及可用静态方法；媒体实际格式/编码；MSE/MMS 最终是否生效；首帧指标字段；切源事件归属；字节命中情况；资源过期和后台下架时的行为。文档阅读不能替代这些运行证据。

## 11. 当前代码对照

本次仅审查，未改这些实现：

- `src/pages/square/usePlaybackPreload.ts` 等待所有当前可见封面 complete 才开始默认媒体预热。一张慢图可推迟所有候选；这不是官方预加载的要求。
- `src/player/preload.ts` 已正确区分媒体信息与字节预加载，也没有在 setPreloadList 前重复查询。同场景更新保留任务，这点应保留。
- 该预加载器改变模式时会取消任务，首页到播放页的交接要确认目标集何时已经消费缓存，不能一进页面就取消入口预热。
- `supportsMediaPreload()` 当前检查 `MediaSource` 或 `ManagedMediaSource`；这只是环境能力门禁，还应记录资源是否降级及实际缓存命中，不能把能力检测结果当作命中证据。
- 当前自动参数为前 1 后 2、每集 5 秒、字节缓存最多 5 份；前后窗口与官方播放页建议一致，缓存上限是项目取舍，仍须用命中、卡顿和流量验证。
- `src/player/tiktokMinisPlayerEngine.ts` 已收敛到官方公开的单参数 `playNext(options)`，普通切集前不再主动 `pause()`。
- 播放页在原生广告和临时后台期间保留 Feed 任务，领奖后也继续以 Feed 有序窗口提交刚解锁目标；只在离页、换剧、身份或权益失效等真实边界清理任务。
- `src/player/tiktokMinisPlayerEngine.ts` 已有代际防护、PLAYING/时间推进首帧估计和错误日志；应细化指标而不是重写成 LOAD_START。
- SDK/播放器准备、业务登录、路由判定和首页可见状态需要拆开；首页公开数据与本地历史不该等播放器准备完成。
- 封面当前按组件视口触发，页面相同剧可能在多处出现。要从资源层复用，不能仅调整某一轮播组件。

## 12. 基于上述 API 的方案

### 12.1 启动：拆成独立就绪状态

`宿主启动 → HTML/SDK 脚本 → 业务 JS → 页面与公开请求` 有真实平台边界。业务脚本尚未执行时无法凭空发请求；只能在文档支持和环境配置明确的前提下验证 HTML 资源提示。不能承诺消除 TikTok 宿主自身开屏耗时。

业务启动后：

- 页面壳、公开配置、首页数据、本地历史独立启动，公开接口统一 `/api/v1/open`；按到达结果渐进展示，单个模块失败可重试。
- SDK init 完成后立即缓存 getPlayer Promise；播放器准备和业务登录并行。播放器预热失败只降级预热，不阻断首页。
- 识别启动目标：直接进某集时，优先该集路由解析、必要权益请求和播放器；不要先呈现首页、拉完所有推荐才导航。
- 所有域名从当前应用/环境配置取得。资源提示必须和实际请求的 URL、跨域/凭据模式一致，验证有没有复用，不能硬编码测试域名。

### 12.2 首页：按剧组织，按资源版本复用

建立剧实体引用与资源任务表，卡片只是消费者。相同剧出现在轮播、推荐、More Drama、历史时共享相同封面任务；不同横竖海报、尺寸或版本不是同一份资源，不能强行用一张替换。

接口返回的所有封面立即登记任务，按优先级持续请求，不再以“未滚入视口”为由无限不请求：当前主卡/可见区域 → 下一轮播 → 已返回其他图片。并发受限但低优先级不得饥饿；更多分页尚未返回的数据不凭空加载，返回后遵守同一规则。

图片请求键由完整资源身份与尺寸策略生成，不去掉有意义的签名/版本参数。数据刷新后引用新版本；旧失败不可永久缓存。初次失败有限重试，仍失败显示可识别的兜底；不能用假成功掩盖 URL/CORS/CDN 故障。

轮播数量来自数据，非固定 4 张。自动切换前确认目标图片已解码或有明确兜底；短暂未好可延后，不能永久卡在坏图。用户手动滑动仍响应。More Drama 返回顶部按钮沿用已完成实现。

注意：以上是业务图片方案，并非 VePlayer 为首页提供的功能。不能混用 SDK 视频缓存与浏览器图片缓存。

### 12.3 首页视频预热：明确候选，不等全部图片

图片持续请求与视频预热各有预算。根据当前主卡、用户触摸意图、最近观看集选一个高概率入口；选择优先级可以随交互提升，但不得让慢图阻塞这个判断。

先满足本项目权益约束，再提交已授权剧集标识。MP4/MSE 路径使用普通场景字节预热；其他路径只预请求媒体信息。不要为首页每张卡或整部剧下载视频。

“接口拿到就都请求”用于用户要求的首页图片；视频字节按官方建议限量预热，二者不可混为一谈。并发数、候选数、时长先作为可调实验参数，不称为最优值。

### 12.4 进入播放页：当前集独立完成，预加载只辅助

- 已有入口预热：保持同一 source 参数和全局构造器，创建当前集播放器；在确认目标起播、已消费可用缓存后交接自动模式，避免提前取消。
- 无入口预热：准备可用的自动场景配置，但当前集不等待邻集权益、全剧媒资查询或下载完成；预加载模块失败仍可正常创建官方播放器。
- `READY` 后访问内核；信息就绪、媒体加载、播放开始、帧显示分别记状态。首帧前保留本剧封面。
- 自动播放受阻显示可点击播放，不把它当成登录失败或切集失败；不因此循环重建播放器。

### 12.5 连续播放、权益与恢复

一个页面一个播放器实例，用 playNext 切集。目标集先验权，锁集走现有广告/权益流程。使用切换代际和目标标识屏蔽旧请求、旧帧和旧事件；成功提交、真实开始播放是两个阶段。

Feed 列表维持真实播放顺序，但只能包含允许预热的资源。不可为了填满“完整列表”绕过 API 权益校验；跳过锁集也不能让 SDK 把后面的集误认为紧邻集。必要时仅提交当前可连续授权窗口，窗口变化后更新。

广告打开、后台、锁屏时暂停并保存本地进度；只恢复此前正在播放的会话，保留用户手动暂停意图。离开播放页销毁实例并解绑；全局任务/缓存分别按情境处理。身份或权益失效时先停任务再清缓存，拒绝迟到结果重新写入。

服务端下架、换资源、分发变化：前台重新验权/刷新数据；SDK 缓存不替代最终资格判定。公开展示缓存与用户权益缓存分离。

### 12.6 观测和错误处理

保留现有结构化日志，增加可关联阶段：启动、公开接口、SDK init、getPlayer、prepare、权益校验、媒体信息命中、字节命中、创建/切源、READY、PLAYING、实际帧或估计帧、缓冲等待、销毁。

日志只包含应用/环境和业务 ID、耗时、格式/编码、实际能力、命中量与脱敏错误。禁止输出 Token、签名 URL、SDK 原始对象或完整响应。

9301 参数问题、9302 无剧集、9303–9306 审核/撤回、9308 旧版能力、9310 下架等按平台状态处理；9307/9399 需结合具体原因诊断，不能一律当网络抖动。瞬时网络错误有限重试，永久内容状态不自动重试。用户提示复用固定英语文案。

## 13. 验收范围与实施顺序

先补充失败用例和阶段观测，再改调度；逐层比较基线，不同时替换播放器、缓存、路由和图片来混淆原因。

| 验收组 | 必测内容 |
| --- | --- |
| 启动 | 冷/热启动；首页/直达某集；登录慢或失败；SDK 准备失败；公开页仍可见 |
| 图片 | 数量 0/1/多张且超过 4 张；同剧多位置；滚动快；自动/手动轮播；慢图、坏图、刷新换图；所有已返回图片最终均开始请求 |
| 播放 | 有/无预热；媒体命中与字节命中分别验证；首播/续播；快切/连切；最后一集；切源失败 |
| 运行能力 | iPhone 真实 Minis 的原生/MMS 路径、Android MSE；MP4/HLS、不同实际编码；不支持预热仍能官方播放 |
| 生命周期 | 广告返回；手动暂停后后台；锁屏；关闭后重进；播放页返回首页，无残留声音和旧任务 |
| 权益与内容 | 锁集/奖励成功与失败；下架；资源替换；后台分发与封面更新后前台刷新；缓存不能绕过新结果 |
| 环境 | sandbox/production 各自域名、应用和数据隔离，不依赖写死地址 |
| 观测 | 起播耗时分段、图片解码、字节命中、卡顿/恢复、废弃下载量；不以加载事件假报首帧 |

先在本机验证状态与竞态，再使用二维码进入真实 Minis 测试。构建成功或浏览器可见不能代表真机播放器链路通过。本次为文档研究，未执行本轮性能修改、重新打包或真机验收，也不承诺尚未测量的耗时目标。
