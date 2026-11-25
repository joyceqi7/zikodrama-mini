import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** PlaybackGateState 暂停已挂载的剧场，重查门禁不取消当前解锁流程。 */
interface PlaybackGateState {
  /** blocked 为真时禁止播放、业务倒计时和新的广告请求。 */
  blocked: boolean;
  /** isBlocked 供原生回调读取最新门禁，避免异步闭包使用旧状态。 */
  isBlocked(): boolean;
  /** waitUntilReady 等待当前门禁重新放行，离开主体或剧目时返回 false。 */
  waitUntilReady(): Promise<boolean>;
  /** entryAdDelay 暂缓需要执行的入剧或强制 VIP 门禁，仅按服务端许可播放首集。 */
  entryAdDelay: boolean;
  /** entryAdTimePending 表示详情前台时间未达标，锁定首集的解锁广告也使用此时钟。 */
  entryAdTimePending: boolean;
}

const ready: PlaybackGateState = {
  blocked: false, isBlocked: () => false, waitUntilReady: async () => true, entryAdDelay: false, entryAdTimePending: false,
};
const PlaybackGateContext = createContext<PlaybackGateState>(ready);

/** usePlaybackGate 将门禁阻塞接入播放器和连续广告，不以本地状态推断权益。 */
export function usePlaybackGate() { return useContext(PlaybackGateContext); }

/** PlaybackGate 首次放行才挂载；重查可保留当前视觉但仍阻止业务推进，主体或剧目变化由调用方的 key 隔离。 */
export function PlaybackGate({ allowed, fallback, children, preserveContent = false, entryAdDelay, entryAdTimePending }: {
  /** allowed 仅由服务端状态及其有效期决定。 */
  allowed: boolean;
  /** fallback 在等待确认或未达标时展示恢复入口。 */
  fallback: ReactNode;
  /** children 放行后保持挂载；默认阻塞时隐藏，保留视觉时仍须消费 blocked 暂停业务。 */
  children: ReactNode;
  /** preserveContent 仅在已挂载弹窗的正常重查期间保留视觉；不解除 blocked 或唤醒等待中的业务。 */
  preserveContent?: boolean;
  /** entryAdDelay 由入剧门禁提供，内层门禁继续传递是否暂缓。 */
  entryAdDelay?: boolean;
  /** entryAdTimePending 由入剧门禁提供，与播放器初始化和播放进度无关。 */
  entryAdTimePending?: boolean;
}) {
  const parent = usePlaybackGate();
  const blocked = parent.blocked || !allowed;
  const [opened, setOpened] = useState(!blocked);
  if (!opened && !blocked) setOpened(true);
  const preserved = opened && preserveContent;
  const hidden = blocked && !preserved;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const active = useRef(true);
  const waiters = useRef(new Set<(ready: boolean) => void>());
  const isBlocked = useCallback(() => !active.current || blockedRef.current, []);
  const waitUntilReady = useCallback(() => !active.current ? Promise.resolve(false) : blockedRef.current
    ? new Promise<boolean>(resolve => { waiters.current.add(resolve); }) : Promise.resolve(true), []);
  useEffect(() => {
    if (blocked) return;
    waiters.current.forEach(resolve => resolve(true));
    waiters.current.clear();
  }, [blocked]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      waiters.current.forEach(resolve => resolve(false));
      waiters.current.clear();
    };
  }, []);
  const delay = entryAdDelay ?? parent.entryAdDelay;
  const timePending = entryAdTimePending ?? parent.entryAdTimePending;
  const state = useMemo(() => ({ blocked, isBlocked, waitUntilReady, entryAdDelay: delay, entryAdTimePending: timePending }),
    [blocked, isBlocked, waitUntilReady, delay, timePending]);
  return <>
    <PlaybackGateContext.Provider value={state}>
      <div hidden={hidden} inert={hidden} style={{ display: hidden ? "none" : "contents" }}>{opened ? children : null}</div>
    </PlaybackGateContext.Provider>
    {!allowed && !preserved ? fallback : null}
  </>;
}
