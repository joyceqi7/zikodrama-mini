# Mini 审查覆盖清单（2026-09-21）

配套 [审查报告](mini-full-audit-2026-09-21.md)。文件从当前 Git 跟踪集合枚举，行数含空行/注释。SHA-256 固定交付时审查版本；后续修改不自动继承本次结论。

## 覆盖口径

- 第一方生产源码、样式、测试、视觉夹具、脚本、构建和部署配置均已读取审查；并行发生的改动按 diff 补审。
- 环境与应用配置仅核对字段、类型、环境隔离、URL 属性及有效期，不复制凭据和签名地址。
- package-lock.json 为生成文件：解析包清单、锁定版本，并执行生产依赖公告扫描；**不是逐行审读第三方实现**。
- node_modules、dist、构建缓存、Git 元数据、私有本地配置、截图/视频二进制、历史方案文档不属于第一方可执行代码逐行清单。相关工程、播放器、UI、发布文档作为上下文读取，不把文档总行数充作代码审查量。
- “审查完成”表示这个快照的静态覆盖完成；不等于每条分支均有动态覆盖或已通过真机性能验收。

## 数量

| 类别 | 文件数 | 行数 |
|---|---:|---:|
| 配置 | 18 | 355 |
| 锁文件（结构与公告核对） | 1 | 9218 |
| 脚本 | 5 | 1014 |
| 测试/夹具 | 43 | 7200 |
| 生产源码/样式 | 77 | 9786 |

## 逐文件版本

| 文件 | 行数 | 方法 | SHA-256 |
|---|---:|---|---|
| `.dockerignore` | 5 | 配置 | `b345587cdd99f922cf4555c9265721d840376df6c2d69c29b71035e26865e067` |
| `.env.development` | 5 | 配置 | `12a9dcf98e71494b48f9d1ebe1dadab51aeee07361f10b64ecfb93bf0a7c25d4` |
| `.env.example` | 6 | 配置 | `c0da93f7dcb00c8da4350f16fea138285f22caf1676767cf20920f9ad15d61af` |
| `.factory/project.yaml` | 23 | 配置 | `823e66c7d01f48b50d8a774018c8fde89285ec21983ecb33626245b6b98f6b70` |
| `.gitignore` | 22 | 配置 | `6d6d0274f1977a849de7089947827029cc08a36615ff40926027cb76fcb3ffa2` |
| `Dockerfile` | 39 | 配置 | `a4939f5f6325b8673cdbac5ea0fcfec0b03d3d6b61d914e7ba4595b9c4ee2707` |
| `Makefile` | 30 | 配置 | `daa4b165f75da9ed2f50641b283a856012814a8b0842ee09d676a3f973672aa6` |
| `configs/apps/7685293427067586568.json` | 14 | 配置 | `d39f7068ed580e08f06074d4ca322889417299974c3627008f62ff7b72657443` |
| `configs/apps/7685989013308475410.json` | 14 | 配置 | `279a5e501af0ac6486faa2c40a154c8f886868bcac2c5d06ccfb485c81cf6e70` |
| `configs/apps/example.json` | 14 | 配置 | `76bfe13c4ccf54f01dddf50d170a69b03f2d0b3044ba1da76801d3af8fbde1eb` |
| `deploy/nginx.conf` | 28 | 配置 | `94d31f11c34fd685f6ee322b7f72c4f6809ae1a454cf1bf9df2667cfee5b1b45` |
| `index.html` | 31 | 配置 | `0f8885d7061f4e88cc218c0ea7967082854d4fa9605fa20e2bc0e96b253eb7d1` |
| `minis.config.json` | 18 | 配置 | `d71aa9fb965104a0275a99a13531e6d737c00a4176f5d9ac042cf8c2d9161d1c` |
| `package-lock.json` | 9218 | 锁文件（结构与公告核对） | `ccefe08573959195619b1e0c640254eae9c34a9134ca9605786af6e9c1114107` |
| `package.json` | 48 | 配置 | `034ffd2dd46d730649279d46ed92b3585b52965b2d54b70999967ce5ac7fbf85` |
| `scripts/app-selector.mjs` | 86 | 脚本 | `53cff7f343d2edc00571aa4bdacf72645eed7673554a74460877517c864edfce` |
| `scripts/dev-minis.mjs` | 148 | 脚本 | `cebd74156106df370819c255cdbe23551ff20e9002f501029fe3764af3174331` |
| `scripts/package-minis.mjs` | 344 | 脚本 | `678f6f5ea63daa95b7176b904c9acb0605722e5433ec4189339f70e72858770c` |
| `scripts/prepare-local-catalog.mjs` | 392 | 脚本 | `4e33e0344a12119e40a2a65333a37ddd9e28e41a3a54d0bb6a23cf7b5d49d8c8` |
| `scripts/validate-web-build.mjs` | 44 | 脚本 | `86d6aef0d3617994650f7db582870625007361da38c6a77ecf8cd1b15f3ca9bf` |
| `src/App.test.tsx` | 553 | 测试/夹具 | `8b976191b2c43e0e7d59984001ca54a1df05f8b66e0946a9197e3e4e5240c10f` |
| `src/App.tsx` | 259 | 生产源码/样式 | `8fd1f1623774285ffa7219a0ede6a0fb2b2302333b57810ab02bde2276398a07` |
| `src/account-ui.css` | 65 | 生产源码/样式 | `f766852885746b723244f540281f77876861d63c8f8d3fd1887ab1267e41332a` |
| `src/api/httpMiniDramaApi.test.ts` | 398 | 测试/夹具 | `da161ad6f7252a3987b8cb23de5126b92db6e3166c3ca3fb9f9dbb17c5f14172` |
| `src/api/httpMiniDramaApi.ts` | 457 | 生产源码/样式 | `8e0def935e1915a509f01ff6330f4454ef7fa3136fce0432edef20ee344a39e9` |
| `src/api/identityRecovery.test.ts` | 155 | 测试/夹具 | `6a1daa9be5df0ee8636ca2a36c7c5dc0d4e3ea8a8aa82bb18aabe45e40878b80` |
| `src/api/userMessage.ts` | 36 | 生产源码/样式 | `1e0bef8ce18a557d7e8c146831f4c14540c2cbab778a728dc40a671e228d1a90` |
| `src/compliance/links.ts` | 39 | 生产源码/样式 | `28a2bfdb738d5cb4f2d17c705302f6e7e52a5e828016bfde8f20d88f5a4b42b1` |
| `src/components/AccountHeader.tsx` | 19 | 生产源码/样式 | `3aeb38f057175d93d28bb2790f7a4f10e21a564945d6c5974f0e8804c3ce8708` |
| `src/components/AutoUnlockDialog.tsx` | 53 | 生产源码/样式 | `d212bc9b1c8e5333ce05638c30ea7285ba95ec2f4bed8b0248ea7f317b44bc2b` |
| `src/components/BottomNav.tsx` | 30 | 生产源码/样式 | `a35f65600ec7823eb57bac3c3ceda22fc4987fe1e0259545a40a428f9e98eedb` |
| `src/components/DramaCard.tsx` | 28 | 生产源码/样式 | `92cc1827f530dd59a6795b66d0a26049423d8a7fb1768546fe1b5b234fa52e88` |
| `src/components/DramaPoster.tsx` | 42 | 生产源码/样式 | `176f6dc1efbb293db41b35e80cb097ae602878139edbc8fed7b4da6d68ee0997` |
| `src/components/EpisodeSheet.tsx` | 95 | 生产源码/样式 | `ce7f3fbccea7722fec06899bd8c0061a96bcc2f15494d3a8e929c01d01cb5f57` |
| `src/components/HomeHighlights.tsx` | 241 | 生产源码/样式 | `00d01b05aec9d286092c406adc66f2f579539d911aa3e43d431f8920ea0276d3` |
| `src/components/MediaImage.tsx` | 53 | 生产源码/样式 | `d9459907915557b2c4bc192dccbd93b2369fda6d534a18fb7201573fdb068164` |
| `src/components/OfficialIcons.tsx` | 20 | 生产源码/样式 | `45d25215afa1172c7a2ac57b626e488870beb3d3db8875249705349d4663e47e` |
| `src/components/PlaybackRateSheet.tsx` | 60 | 生产源码/样式 | `5c9ecc15f05c2261749c6d6850313df7360649356d67e258288dae091df35eb4` |
| `src/components/RewardedAdResumeDialog.tsx` | 68 | 生产源码/样式 | `54ab6195e478d64f32fb61832633aedd14ff32616e03dd29c7615174f1fce9de` |
| `src/components/VipDialog.tsx` | 168 | 生产源码/样式 | `e596ae180aee8080f8ec5d5ebf1bbbb76451b8f53ed634ab34d81f7e5b75dc59` |
| `src/components/coverLoader.test.ts` | 35 | 测试/夹具 | `0fa9a4e4e564c985160267909dbf34170f400a5d859bdc31179bbb0952ae4517` |
| `src/components/coverLoader.ts` | 135 | 生产源码/样式 | `464cffd5dc0219a9d085cf431dbd63c8846f8f9e7e17b6aa26d870dbdd3319f5` |
| `src/components/coverThumbnail.ts` | 6 | 生产源码/样式 | `4420708e5ec62cc35d28cd332f6d9e0ba36fa4a86e49466b7d006b4c28fec4ef` |
| `src/components/homeImagePreload.ts` | 15 | 生产源码/样式 | `00c019f0243d1808b88554180283a05c7b306af4b5b800964d9d858967864723` |
| `src/components/slider-item/index.tsx` | 66 | 生产源码/样式 | `680470c8ee1e77af254f53f405ef760a22478961852d87f7ff8990667984091a` |
| `src/components/useForegroundRefresh.ts` | 28 | 生产源码/样式 | `57b2ff95b080cf2299d1b95fcda80a837deb6028b76f1831f2a42615d83f639e` |
| `src/components/useHomeScrollAnchor.ts` | 25 | 生产源码/样式 | `95f58516c9679bb93104c495e665bd3023bb52f7714deaed01f940c63b3854ee` |
| `src/components/video-swiper/gesture.ts` | 33 | 生产源码/样式 | `d03365d50e03be68cd752ed08940cdee394f30abbb427bad703cfb6db678b94d` |
| `src/components/video-swiper/index.test.tsx` | 368 | 测试/夹具 | `95681f3efd7eb8997bfa29f5c2b84fd2c6e6a90a930e887e4e665740be6a7611` |
| `src/components/video-swiper/index.tsx` | 362 | 生产源码/样式 | `4438fbdeccae47dba8c81e252a883f62a4317647f9b80c55bb673e211b258619` |
| `src/config/applicationProfile.test.ts` | 25 | 测试/夹具 | `e442ee5a6bd1c10919f137543403ae0e8636462594e6bb5b9bb62939bda02961` |
| `src/config/applicationProfile.ts` | 54 | 生产源码/样式 | `afb40ec69cec9732b7ca1deb142435564f3325f08035e8f24acdb0eb7f455014` |
| `src/copy/index.ts` | 11 | 生产源码/样式 | `97f67b573a10f6f1134b8deb2d1bd2acd299b40acbe44ff90daa17163a10e74a` |
| `src/copy/messages.ts` | 211 | 生产源码/样式 | `b89bb8d88fbc0ec0955c6d75dc8d89835e9a26b2d1bc905dd3de25e8c3bc7498` |
| `src/domain/id.ts` | 13 | 生产源码/样式 | `e6a0ef2b799d7aa617202b032cd940f8686f5c3fc0c3400776e97a59cf19f5b0` |
| `src/domain/localLibrary.test.ts` | 192 | 测试/夹具 | `2f9c3a96e499bc7e906554c2816ae9de56b1ea2f923f9db0b5e0b417d623e041` |
| `src/domain/localLibrary.ts` | 228 | 生产源码/样式 | `d666e1d7f94d1c2004740e4b2c6ee24edc65cf4107e3029c9234b295995aac9b` |
| `src/domain/offerStrategies.ts` | 45 | 生产源码/样式 | `c6ae689b161933506cf0c4f652ad04a5bc214867781d54ef398b0ce62e9071b3` |
| `src/domain/pendingClaims.test.ts` | 157 | 测试/夹具 | `165943fd6d1c5f0422669d9363d1f9177ba84247e5122f75fc73944a25fe10cf` |
| `src/domain/pendingClaims.ts` | 173 | 生产源码/样式 | `bf215d9fc6a988249f1df36af64160bb290cd78ae2b2f8863bc739079cf5ab8b` |
| `src/domain/resumePlayback.ts` | 7 | 生产源码/样式 | `01552b443e2d8138779f07a11f536e2552041d6483b76577f8aa16b7b45ee244` |
| `src/domain/rewardClaim.ts` | 23 | 生产源码/样式 | `f505af881282ce295bb9183f71e9deb8467d759b97ac8f2840fc154a780625b3` |
| `src/domain/types.ts` | 316 | 生产源码/样式 | `46bd36eca8fac751381144efad1a07f9feac53431a40aa4438d972f6dc14329f` |
| `src/home-ui.css` | 73 | 生产源码/样式 | `1ee54b965f3d162ec19c54e2f078d98f3f8b790fa940e2e806b688a431271d83` |
| `src/main.tsx` | 39 | 生产源码/样式 | `535dcd05947374fcc542675f35f1a442bf77fbda904109dfdf1ede753b68750c` |
| `src/observability/clientLog.test.ts` | 47 | 测试/夹具 | `c3f89291b5d6d19a20056583cb0a2d51bc99ebd151d518c3748a614471c86989` |
| `src/observability/clientLog.ts` | 76 | 生产源码/样式 | `9487c3ef8b3e33dc134f3b9b8a2447bc461a4d5d6fe43b36450dd69238c195c9` |
| `src/observability/metrics.ts` | 163 | 生产源码/样式 | `1a6f7d18687979aa3f0a1abd0c0c9be5d05fd1c9de4974034d6c62c0b1b998ef` |
| `src/official-ui.css` | 258 | 生产源码/样式 | `8a82e677e1103e32fdc83025a0ece96298f28c319cb447e435a2f7eba26dfb6a` |
| `src/pages/HomePage.tsx` | 1 | 生产源码/样式 | `f1e481e64eb5f4b81fbd8a86da96c52b4dac73887c8972624fcecc57932f8785` |
| `src/pages/LegalPage.tsx` | 156 | 生产源码/样式 | `7bfeb232bf64eb343c9e8e59690fcd7163dad6cb322a10869d45d80740b98040` |
| `src/pages/LibraryPage.tsx` | 106 | 生产源码/样式 | `4f5d9ac66bc27afdd84f4e0b4a7c8f6e6be670894f559edf01a2af9b1e75af72` |
| `src/pages/PlayerAutoUnlock.test.tsx` | 213 | 测试/夹具 | `c104bacba6132cb6df940052b57720a20d043b09d64458bffd206e35ccb7376a` |
| `src/pages/PlayerPage.test.tsx` | 1536 | 测试/夹具 | `ba5a17949b0931b1d4ca5d4bc094c1bca7d0cf57a18b44dd298634f6b21b6c92` |
| `src/pages/PlayerPage.tsx` | 5 | 生产源码/样式 | `990303c48e353fc7b54e5705f285233c0ba0a76a2eb187024203e1013630c64e` |
| `src/pages/ProfilePage.tsx` | 41 | 生产源码/样式 | `9cd37f49bb117eb17bcc35e41287099d3f5b85568e8bb029d8451f8bc9472a56` |
| `src/pages/square/index.tsx` | 225 | 生产源码/样式 | `3a7352f7d11d9a65ee82b9dde9047028e30642c3af780a9445c1f8715a044351` |
| `src/pages/square/usePlaybackPreload.test.tsx` | 108 | 测试/夹具 | `48037e00fe2e982f928348172600da131eb1cc4652d1c45414300c24fe878283` |
| `src/pages/square/usePlaybackPreload.ts` | 96 | 生产源码/样式 | `8cdd34d36335a7b03d9f62d6070d82219ca0ab9ce019c4818d6f405897211d26` |
| `src/pages/theater/episodeRanges.ts` | 30 | 生产源码/样式 | `1739d442fcf355de50042e530abec873e199e38161ef10ac6310df9ef6bebdc0` |
| `src/pages/theater/index.tsx` | 1380 | 生产源码/样式 | `65962f9b6077a8ce1c0cc9da744814b2ffacb87c328c2c54eaf7d812de6bcca2` |
| `src/pages/theater/useAutoUnlock.ts` | 107 | 生产源码/样式 | `ea6b12bad5a8be680dc3b9f7467eeda6014ff084ef42aaf04f540cdc59b45927` |
| `src/platform/tiktok/errors.ts` | 16 | 生产源码/样式 | `e269d877e06dce37b9f08f960611a2296151d9fc52e8cb8ab9d992f8828ba12e` |
| `src/platform/tiktok/events.test.ts` | 160 | 测试/夹具 | `18497c0c91fb728d3de7c816daeb0f7b8016a7c73cae8afd2247a6b93e183159` |
| `src/platform/tiktok/events.ts` | 181 | 生产源码/样式 | `3e29d25532389374866652064445eee75cfc13109a5e4a76615681408ff394fb` |
| `src/platform/tiktok/integration.regression.test.ts` | 91 | 测试/夹具 | `e332818063250ac6d9c25d195da89d7eda11535a66b1bfcef9a33dd449439140` |
| `src/platform/tiktok/interstitialAd.ts` | 62 | 生产源码/样式 | `d277dcb4d3e872d65c78135419226d6d746207c287080b659bd45732aa000ba2` |
| `src/platform/tiktok/lifecycle.ts` | 38 | 生产源码/样式 | `f2e1b1ab83a93cd5f77bd1c3312ff6544c47af8003635986bda3478111a536ae` |
| `src/platform/tiktok/login.test.ts` | 89 | 测试/夹具 | `54c9aa95fc6740554faa0ad9e06a9d76bcfc9cfbb9b9a0b615480bf9055ed143` |
| `src/platform/tiktok/login.ts` | 55 | 生产源码/样式 | `52754610f231d2381cc4da44ca9d17e859a57bedb40a1d5e659bea722fe355ad` |
| `src/platform/tiktok/navigation.ts` | 39 | 生产源码/样式 | `8f587cfa58c128ccb1723c726ff681ffa83d7618f0ad5bbacfbc3d62da7252c7` |
| `src/platform/tiktok/rewardedAd.test.ts` | 191 | 测试/夹具 | `6a3d3b00f99615f3ef617931dc21e9791f19c278e02ef733e6a635d15d89536a` |
| `src/platform/tiktok/rewardedAd.ts` | 115 | 生产源码/样式 | `678f2b5b2c7d24c234cf6613e0b7642eba325a94de96a6e4567036ff295760c5` |
| `src/platform/tiktok/sdkReady.test.ts` | 92 | 测试/夹具 | `b4084e1ad246fbfc54246b9ff77c00d051733ce4e2c60b8c946111b7b387bd2b` |
| `src/platform/tiktok/sdkReady.ts` | 50 | 生产源码/样式 | `70ab13b7495f5079751134df9b0f15e91c02c5f3b88cf7ded98c865ee7d11f87` |
| `src/platform/tiktok/share.test.ts` | 42 | 测试/夹具 | `c8d59e40eb53163cb2d3daf501e625ebb52a1f8799d0aa633400d966d662af3e` |
| `src/platform/tiktok/share.ts` | 70 | 生产源码/样式 | `3ad4d1c4fc10c31483d3910c7df094898133a9d686040cf2901d61f59dbc038d` |
| `src/platform/tiktok/systemInfo.ts` | 66 | 生产源码/样式 | `dc6c35554d1b98d1d6fcfc90c7f38faac3ea2912799dc706d7c1a542268fa414` |
| `src/platform/tiktok/types.ts` | 272 | 生产源码/样式 | `a47cd34b592f20afe7c24a9e63232df26aadbbd5198ecf6132e79d002fda942c` |
| `src/player/index.ts` | 3 | 生产源码/样式 | `01e6ef1a1851aee37699acd0fbea49737f2ab1d891f17498f5fa891a4d461d3b` |
| `src/player/playbackEngine.ts` | 84 | 生产源码/样式 | `5f54919d571693ade2242fa89fca15d1a9f756daefc1d7393c74b084f4746dc1` |
| `src/player/playbackProgress.test.ts` | 116 | 测试/夹具 | `1e8e06feb4c199688cbda8074a407648eb063ea7612c42a623abd8e62d44b0e5` |
| `src/player/playbackProgress.ts` | 127 | 生产源码/样式 | `0d8c88206c6de43075c5f12652b365703d3d98766f451114f6476e0fd0f39a31` |
| `src/player/playerLayering.test.ts` | 89 | 测试/夹具 | `1996cd98ddf0bab4de6557fb60d82832b66d023a48e7fbfe08c24d4979922686` |
| `src/player/preload.test.ts` | 74 | 测试/夹具 | `2a20b4b329f73404b29213ac66f06339e0b0940894584bd81ee47bce8e67db92` |
| `src/player/preload.ts` | 81 | 生产源码/样式 | `d375a83285645945123b985f07ff280166f2d1c47a2ee4353df275d43bdbbf2a` |
| `src/player/tiktokMinisPlayerAdapter.ts` | 62 | 生产源码/样式 | `8043f463a1fd75ab0cac605384256f0aa4c29adadcee8c792a9719989b3c60ea` |
| `src/player/tiktokMinisPlayerEngine.regression.test.ts` | 135 | 测试/夹具 | `bae8815d1b56bf1d2d4c4cb36945962f0124478c62777119dc9741e81df21ccc` |
| `src/player/tiktokMinisPlayerEngine.test.ts` | 223 | 测试/夹具 | `9e108226bcd198ff33602c760457f7a6f89e069db5ac4fe16231b4bb55fa2c47` |
| `src/player/tiktokMinisPlayerEngine.ts` | 455 | 生产源码/样式 | `3a58a75e57bfbb0af4dad1fbef91538d2d329d9c8dae7fed0e65a221ccb7a446` |
| `src/runtime/RuntimeContext.tsx` | 11 | 生产源码/样式 | `599af0bd6fe9dd49b6bc380752dafc12d225fe151f5d5f029d2227e028b328fb` |
| `src/runtime/claimRecovery.test.ts` | 487 | 测试/夹具 | `2f51f32ff2d4103b2607ca98ee5494e3ff9a29f5e308f3986fc6a7a79f02ce2a` |
| `src/runtime/launchRoute.ts` | 7 | 生产源码/样式 | `9f4a3283b06af0fc7ec3cd5172aac163abda2b183ca1ca608c4de753294028d8` |
| `src/runtime/playbackCache.test.ts` | 81 | 测试/夹具 | `2c7f1316e60cf7c79d91443f0662fb723906885d4ab129726a864f2acb40e8dc` |
| `src/runtime/playbackCache.ts` | 38 | 生产源码/样式 | `8aab7365c9e039ae7395c274aa110b76b9fc90cc21a63a33a250cc2e7ce5b9d1` |
| `src/runtime/playbackLaunchCover.test.ts` | 20 | 测试/夹具 | `d3d839db7a1866332cb8238ed2e8ccfe712f8a6d46a4634b30936e8e849022a6` |
| `src/runtime/playbackLaunchCover.ts` | 16 | 生产源码/样式 | `2bb725016c37f93aaa21b7a9b6664ac2e103d2d9dd758c89776d227e0633099f` |
| `src/runtime/publicHomeCache.test.ts` | 70 | 测试/夹具 | `87b9ea3a462e305196f1ed6ace73ac4e261f6eabfaa770e90c017219b0fc33f6` |
| `src/runtime/publicHomeCache.ts` | 118 | 生产源码/样式 | `11fb9fcce840b5e152d298a4079dde23acf4ee6d79437dd511c6263f02b82ff9` |
| `src/runtime/runtime.test.ts` | 411 | 测试/夹具 | `cd63947347836dc8234fc05d01d7af38d0f1d7d2901afdf1ee75cba9cb868c23` |
| `src/runtime/runtime.ts` | 910 | 生产源码/样式 | `ef303feb49186a65d55e285c3e08b6499eee0b1eeaf361184a3bf8e8f1a9d431` |
| `src/runtime/useAdExperience.ts` | 12 | 生产源码/样式 | `a874260d961c3afe7bdd708de6116b6db93a578882ba4872542ba6ea9d343c2d` |
| `src/styles.css` | 612 | 生产源码/样式 | `f076c83fb8d508db19361d5c555d6bde76e185616a69229c8f0e96029e1aed14` |
| `src/test/setup.ts` | 12 | 测试/夹具 | `fef1ae26006c23b9aa937a4a1ee5af2ae5629ba82f80c23ff2caee30eb87de89` |
| `src/test/tiktokFixture.ts` | 35 | 测试/夹具 | `579c05b40650b8045c9f0a37f88a4838c4299f4ac491a9b119324d7363e9357c` |
| `src/utils/preload.ts` | 18 | 生产源码/样式 | `f69115662c9548b1b1c740a9c8149a3fb669074a058a118cf8c01a43817b89b0` |
| `src/vite-env.d.ts` | 28 | 生产源码/样式 | `4adecce550c0e54f35153cd41ae5426e9e73a227a1acf97c8ed1350117207786` |
| `tests/app-selector.node.mjs` | 52 | 测试/夹具 | `276a7c877a1417406f7d363a6edd1807c79229d4bca2c9464223fc6654296426` |
| `tests/dev-minis.node.mjs` | 210 | 测试/夹具 | `0cf33bba5f4847636bc9d4cc34f48ebab4ea93c958a34179c14b26bd026e8ae0` |
| `tests/development-environment.node.mjs` | 17 | 测试/夹具 | `66c99a4e6167f990aa70c04f53c57efb52d30476c00b5a1901abc31d904e6d48` |
| `tests/official-player-policy.node.mjs` | 50 | 测试/夹具 | `e6e081e03deac3910378fb9a7a699838c5cf57e45e7f1aaa1ea1df8943c3e21a` |
| `tests/package-minis.node.mjs` | 238 | 测试/夹具 | `85774a6bd7dcffe65fe1aabb082bed36752b48f9573223b5070a885cf62f4b50` |
| `tests/prepare-local-catalog.node.mjs` | 138 | 测试/夹具 | `5d1edcb0f47be58c8867be39791ac40fc596dbfabef0197213b85d5127807a7c` |
| `tests/validate-web-build.node.mjs` | 28 | 测试/夹具 | `3d56a38aa37dee39db1b77b6989d8ddd2b5f6e454dfaae5cf3c1f9b4c65baae4` |
| `tests/visual/account-pages.html` | 1 | 测试/夹具 | `91a06f1a9089b19d1b59ab225f270b5c0920ff6565e51e39df89f6a7bc475ee4` |
| `tests/visual/account-pages.tsx` | 57 | 测试/夹具 | `e76b86e460648677df00783d4b87f88f7b28ebfd77ad73bfad3f6b11487678a7` |
| `tests/visual/auto-unlock.html` | 1 | 测试/夹具 | `5d9cde13c38bed70ca5761860ded57433894dcac95d234884e84606d2ce870ae` |
| `tests/visual/auto-unlock.tsx` | 100 | 测试/夹具 | `def7df4377eb429aab0ad6298aeab778a578043ab1df292121496007484d5101` |
| `tests/visual/home-page.html` | 1 | 测试/夹具 | `2d7981a0c6656bc6a76a869297c19981b8a18af4c15d9707da25e2f84636c9be` |
| `tests/visual/home-page.tsx` | 102 | 测试/夹具 | `807f7e203c627776f33ce895cf7293050dce8e9d788ac6799b6d92732daee4c5` |
| `tsconfig.app.json` | 21 | 配置 | `d9111f3dafa9cd164bbfabdec835b79d908a5f04aa66b16dc497336ed67a8b7e` |
| `tsconfig.json` | 7 | 配置 | `770b4140bbb581e2dfd9ea9946ffc9c75a1d86ba7d2db5f77c83e37cbdf9d808` |
| `tsconfig.node.json` | 10 | 配置 | `843c35f20f6d101c456338994e7d3d0c8c94182fcc8b7378f1e096c7ed547234` |
| `vite.config.ts` | 20 | 配置 | `ee084f8f5f6704ed8207e94495b0f56e4eaef74b5df32396d5bb6da5011f3401` |

