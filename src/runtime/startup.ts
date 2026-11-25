import type { Runtime } from "./runtime";
import { logClientEvent, safeErrorMessage } from "../observability/clientLog";
import { preloadTheaterModule } from "./theaterModule";

/** ApplicationStartup 保留同一 Runtime 的启动任务，React 加载完成后不再重复身份或投放决策请求。 */
export interface ApplicationStartup {
  /** runtime 绑定发起任务的实例，禁止另一身份容器复用已完成的启动结果。 */
  readonly runtime: Runtime;
  /** bootstrap 包含静默身份安装及真实投放入口决策；失败保留给界面展示和明确重试。 */
  readonly bootstrap: Promise<void>;
  /** playback 仅在明确播放入口准备可信 provider 的构造器，不请求媒体字节或授予播放权益。 */
  readonly playback?: Promise<void>;
}

/** startApplication 在界面代码加载前开始启动；recoverIdentity 只由用户明确重试授权重新建立身份。 */
export function startApplication(runtime: Runtime, playbackLaunch: boolean, recoverIdentity = false): ApplicationStartup {
  // 先建立启动任务，让播放器共用同一次身份和服务端配置；失败不能自行触发 recoverSession。
  const bootstrap = recoverIdentity && runtime.getSessionState?.() === "recovery_required" && runtime.recoverSession
    ? runtime.recoverSession()
    : runtime.bootstrap();
  // React 块尚未就绪时也立即观察拒绝，保留原 Promise 的失败语义和一次脱敏诊断。
  void bootstrap.catch(reason => logClientEvent("error", "app_initialize_failed", { error: safeErrorMessage(reason) }));
  let playback: Promise<void> | undefined;
  if (playbackLaunch) {
    preloadTheaterModule();
    // Runtime 在公开配置确认通道后才加载对应 SDK；这里不静态引入独立播放器。
    playback = runtime.preparePlayback?.();
    void playback?.catch(reason => logClientEvent("warn", "player_prepare_failed", { error: safeErrorMessage(reason) }));
  }
  return { runtime, bootstrap, playback };
}
