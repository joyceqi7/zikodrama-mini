import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMiniDramaApi } from "./httpMiniDramaApi";

// 测试凭据均为固定假值；所有请求停留在注入 fetch，不调用 TikTok 或真实 API。
const input = { tiktokAppId: "test-app", launchQuery: {} };
const claim = { claimId: "claim-a-0001", offerId: "offer", adUnitId: "ad" };
const settled = { ...claim, status: "granted", rewardType: "vip_progress", unlocked: false };
const identity = (visitorId = "A", applicationId = "app", visitorToken = "token-a") => ({
  applicationId, tiktokAppId: "test-app", visitorId, visitorToken,
});
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
const denied = (status: number, code: string): Response => json({ code: status, reason: code, message: "technical detail", data: null }, status);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("业务凭据错误分类与静默恢复", () => {
  it("后台等待不会终止已发送的领奖请求，恢复后继续消费同一响应且不重发", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const body = deferred<unknown>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ status: 201, ok: true, headers: new Headers(), json: () => body.promise } as Response);
    const api = new HttpMiniDramaApi("https://example.test", fetcher, 1000);
    const rejected = vi.fn();
    const pending = api.claimReward(claim);
    void pending.catch(rejected);
    await vi.advanceTimersByTimeAsync(400);
    visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rejected).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
    body.resolve({ data: settled });
    await expect(pending).resolves.toMatchObject({ claimId: claim.claimId });
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it("后台取消只读权益查询立即结束且不打印错误；预先取消不发送网络请求", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    const controller = new AbortController();
    const pending = expect(api.adExperience(controller.signal)).rejects.toMatchObject({ code: "request_cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await pending;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(api.adExperience(controller.signal)).rejects.toMatchObject({ code: "request_cancelled" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
  it("VisitorToken 到期后无感换发并以原 ClaimID 完成领取", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: identity("A", "app", "expired-token") }))
      .mockResolvedValueOnce(denied(401, "unauthorized"))
      .mockResolvedValueOnce(json({ data: identity("A", "app", "renewed-token") }))
      .mockResolvedValueOnce(json({ data: settled }))
    const api = new HttpMiniDramaApi("https://example.test", fetcher)
    const login = vi.fn(async () => ({ ...input, loginCode: "new-official-code" }))
    api.setBootstrapInputProvider(login)
    await api.bootstrap(input)

    await expect(api.claimReward(claim)).resolves.toMatchObject({ claimId: claim.claimId, status: "granted" })
    expect(login).toHaveBeenCalledOnce()
    const claims = fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))
    expect(claims).toHaveLength(2)
    expect(claims.map(([, init]) => JSON.parse(String(init?.body)).claimId)).toEqual([claim.claimId, claim.claimId])
    expect(claims.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual(["Bearer expired-token", "Bearer renewed-token"])
  })

  it.each([
    [401, "bootstrap_failed"],
    [403, "application_forbidden"],
    [503, "service_unavailable"],
  ])("HTTP %s / %s 不触发静默登录", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: identity() }))
      .mockResolvedValueOnce(denied(status, code));
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    const login = vi.fn(async () => input);
    api.setBootstrapInputProvider(login);
    await api.bootstrap(input);
    await expect(api.claimReward(claim)).rejects.toMatchObject({ status, code });
    expect(login).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["A"])("恢复仍返回401时不递归登录（恢复用户 %s）", async (visitorId) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: identity() }))
      .mockResolvedValueOnce(denied(401, "unauthorized"))
      .mockResolvedValueOnce(json({ data: identity(visitorId, "app", "fresh") }))
      .mockResolvedValueOnce(denied(401, "unauthorized"));
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    const login = vi.fn(async () => input);
    api.setBootstrapInputProvider(login);
    await api.bootstrap(input);
    await expect(api.claimReward(claim)).rejects.toMatchObject({ code: visitorId === "A" ? "unauthorized" : "identity_changed" });
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(visitorId === "A" ? 4 : 3);
  });

  it("bootstrap 自身401直接返回，不递归恢复", async () => {
    const login = vi.fn(async () => input);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(denied(401, "bootstrap_failed"));
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    api.setBootstrapInputProvider(login);
    await expect(api.bootstrap(input)).rejects.toMatchObject({ code: "bootstrap_failed" });
    expect(login).not.toHaveBeenCalled();
  });

  it.each([identity("B", "app", "new")])("应用或用户变化时不重放旧账号领奖", async (next) => {
    const observer = vi.fn();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: identity() }))
      .mockResolvedValueOnce(denied(401, "unauthorized"))
      .mockResolvedValueOnce(json({ data: next }));
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    api.setBootstrapInputProvider(async () => input, observer);
    await api.bootstrap(input);
    await expect(api.claimReward(claim)).rejects.toMatchObject({ status: 409, code: "identity_changed" });
    expect(observer).toHaveBeenCalledWith(next);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("reward-grants"))).toHaveLength(1);
  });

  it("并发及迟到旧401共享一次恢复，并等待观察者完成再重试", async () => {
    const late = deferred<Response>();
    const observerReady = deferred<void>();
    let oldRequests = 0;
    let bootstrapCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("bootstrap")) return json({ data: identity("A", "app", ++bootstrapCount === 1 ? "old" : "new") });
      if (new Headers(init?.headers).get("authorization") === "Bearer old") {
        oldRequests += 1;
        return oldRequests === 3 ? late.promise : denied(401, "unauthorized");
      }
      return json({ data: { dramas: [] } });
    });
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    const login = vi.fn(async () => input);
    const observer = vi.fn(() => bootstrapCount === 1 ? undefined : observerReady.promise);
    api.setBootstrapInputProvider(login, observer);
    await api.bootstrap(input);
    const first = api.home(); const second = api.home(); const third = api.home();
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls.filter(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer new")).toHaveLength(0);
    observerReady.resolve();
    await Promise.all([first, second]);
    late.resolve(denied(401, "unauthorized"));
    await third;
    expect(login).toHaveBeenCalledOnce();
    expect(bootstrapCount).toBe(2);
    expect(fetcher.mock.calls.filter(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer new")).toHaveLength(3);
  });

  it("会话已显式变更时拒绝原请求的迟到成功响应", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: identity() }))
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(json({ data: identity("B", "app", "b") }));
    const api = new HttpMiniDramaApi("https://example.test", fetcher);
    await api.bootstrap(input);
    const reward = api.claimReward(claim);
    const checked = expect(reward).rejects.toMatchObject({ code: "identity_changed" });
    await api.bootstrap(input);
    response.resolve(json({ data: settled }));
    await checked;
  });
});

describe("未确认的领奖响应", () => {
  it.each([
    () => json({}),
    () => json({ data: { ...settled, claimId: "other" } }),
    () => new Response("invalid JSON", { status: 201 }),
  ])("无法确认结算时保留invalid_response分类，不触发登录", async (response) => {
    const login = vi.fn(async () => input);
    const api = new HttpMiniDramaApi("https://example.test", vi.fn<typeof fetch>().mockResolvedValue(response()));
    api.setBootstrapInputProvider(login);
    await expect(api.claimReward(claim)).rejects.toMatchObject({ code: "invalid_response" });
    expect(login).not.toHaveBeenCalled();
  });

  it("网络断开没有HTTP状态，不触发登录", async () => {
    const login = vi.fn(async () => input);
    const api = new HttpMiniDramaApi("https://example.test", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
    api.setBootstrapInputProvider(login);
    await expect(api.claimReward(claim)).rejects.toMatchObject({ status: 0, code: "network_error" });
    expect(login).not.toHaveBeenCalled();
  });

  it("收到201响应头后响应体挂起仍按请求超时结束", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({
      status: 201, ok: true, headers: new Headers(), json: () => new Promise(() => undefined),
    } as unknown as Response);
    const api = new HttpMiniDramaApi("https://example.test", fetcher, 50);
    const result = expect(api.claimReward(claim)).rejects.toMatchObject({ status: 0, code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(51);
    await result;
  });
});
