import { vi } from "vitest";
import type { BootstrapResult } from "../domain/types";

/** splitConsumerFetch 将旧回归场景的完整启动夹具分发给新版接口，仅用于测试。
 * 各场景仍控制认证、领取和个人查询；独立接口合同与并行/故障隔离由 splitSession.test 单独验证。
 */
export function splitConsumerFetch(handler: typeof fetch, configuration: () => BootstrapResult): typeof fetch {
  let session: BootstrapResult | undefined;
  let initialStatePending = false;
  const json = (data: unknown) => new Response(JSON.stringify({ serverTime: new Date().toISOString(), data }));
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).split("?")[0];
    if (path.endsWith("/open/app-config")) return json(configuration());
    if (path.endsWith("/me/vip/offer")) return json({ offer: (session ?? configuration()).vipOffer ?? null });
    if (path.endsWith("/me/vip") && initialStatePending && session) { initialStatePending = false; return json(session.vipState); }
    const response = await handler(input, init);
    if (!response.ok) return response;
    const envelope = await response.clone().json();
    if (path.endsWith("/session") && envelope.data?.visitorId) { session = envelope.data; initialStatePending = true; }
    if (path.endsWith("/me/vip")) {
      const state = envelope.data?.vipState ?? (typeof envelope.data?.active === "boolean" ? envelope.data : (session ?? configuration()).vipState);
      return new Response(JSON.stringify({ ...envelope, data: state }), { status: response.status });
    }
    return response;
  });
}
