import { useCallback, useEffect, useRef, useState } from "react";

/** IncompleteAdPrompt 在本次广告未看完后等待自动重开；换页时仍可取消等待。 */
export interface IncompleteAdPrompt {
  /** countdownSeconds 来自当前广告 Offer，旧 Offer 缺省三秒。 */
  countdownSeconds: number;
  /** displayCountdownSeconds 只决定显示数字的起点，实际等待仍由 countdownSeconds 决定。 */
  displayCountdownSeconds?: number;
  /** decide 只处理首次决定；false 仅由路由清理触发。 */
  decide(continueWatching: boolean): void;
}

/** useIncompleteAdPrompt 按页面路由隔离自动重看，切集或卸载时取消等待。 */
export function useIncompleteAdPrompt(route: string) {
  const [prompt, setPrompt] = useState<IncompleteAdPrompt>();
  const pending = useRef<((continueWatching: boolean) => void) | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setPrompt(undefined);
    return () => {
      generation.current += 1;
      pending.current?.(false);
      pending.current = undefined;
    };
  }, [route]);

  const ask = useCallback((countdownSeconds = 3, displayCountdownSeconds = countdownSeconds): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    const ticket = generation.current;
    return new Promise(resolve => {
      const decide = (continueWatching: boolean) => {
        if (pending.current !== decide) return;
        pending.current = undefined;
        if (generation.current === ticket) setPrompt(undefined);
        resolve(continueWatching);
      };
      pending.current = decide;
      setPrompt({ countdownSeconds, displayCountdownSeconds, decide });
    });
  }, []);

  return { prompt, ask };
}
