import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The plugin is the thing being wrapped, so it is the thing being faked.
// `tauriFetch` is reassigned per test to model each network behaviour.
const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

const { fetch, DEFAULT_TIMEOUT_MS } = await import("@/lib/http");

/**
 * A socket that opened and then went quiet: the plugin's promise stays
 * pending forever and only rejects once something aborts it. This is what
 * a car driving out of coverage produces, and what reqwest — given no
 * timeout — will wait on indefinitely.
 */
function stalledRequest() {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  tauriFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetch deadline", () => {
  it("rejects a request that never responds, instead of hanging forever", async () => {
    tauriFetch.mockImplementation(stalledRequest());

    const pending = fetch("https://lrclib.net/api/search");
    const assertion = expect(pending).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await assertion;
  });

  it("stays pending right up to the deadline", async () => {
    tauriFetch.mockImplementation(stalledRequest());

    let settled = false;
    const pending = fetch("https://lrclib.net/api/search").catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("hands the plugin a signal and a connect timeout", async () => {
    tauriFetch.mockResolvedValue(new Response("{}"));

    await fetch("https://lrclib.net/api/search", { headers: { Accept: "application/json" } });

    const init = tauriFetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.connectTimeout).toBeGreaterThan(0);
    // Caller options survive the wrapping.
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("honours a per-call override", async () => {
    tauriFetch.mockImplementation(stalledRequest());

    let settled = false;
    const pending = fetch("https://example.test", { timeoutMs: 50 }).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(settled).toBe(true);
  });

  it("leaves no timer running after a fast response", async () => {
    tauriFetch.mockResolvedValue(new Response("ok"));

    const r = await fetch("https://lrclib.net/api/search");

    expect(await r.text()).toBe("ok");
    // A leaked deadline would hold the controller for its full duration on
    // every one of the ~20 requests a track change makes.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still lets a caller's own abort through", async () => {
    tauriFetch.mockImplementation(stalledRequest());

    const caller = new AbortController();
    const pending = fetch("https://example.test", { signal: caller.signal });
    const assertion = expect(pending).rejects.toThrow(/gave up/);

    caller.abort(new Error("caller gave up"));
    await assertion;
  });

  it("does not swallow a real network failure", async () => {
    tauriFetch.mockRejectedValue(new Error("dns error: failed to lookup address"));

    await expect(fetch("https://nope.test")).rejects.toThrow(/dns error/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
