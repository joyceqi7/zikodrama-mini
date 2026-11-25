/** timePolicy 统一授权提前刷新和页面内缓存时长；不把设备日历作为业务时钟。 */
export const timePolicy = {
  /** playbackRefreshAheadMs 为网络请求及播放器安装保留的授权余量。 */
  playbackRefreshAheadMs: 5_000,
  /** playbackCacheMs 限制当前页面中验权结果的复用时长。 */
  playbackCacheMs: 20_000,
} as const;
