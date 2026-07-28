import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The boot handshake must not be able to outrun its own reply channel.
 *
 * `listen()` is a round trip to Rust. `App` subscribes and then dispatches
 * `connectivity:check` / `auth:check` / `ytdlp:check` immediately, and each
 * of those is answered exactly once — nothing replays them. So a command
 * that reaches Rust before the listener is registered can be answered into
 * a void, and the app waits for that answer forever.
 *
 * That is the bug that froze the car: on a cold boot the app starts before
 * Wi-Fi associates, the connectivity probe fails with ENETUNREACH in
 * microseconds instead of milliseconds, its `net:status` lands before the
 * subscription exists, and resume-on-startup — gated on a *confirmed*
 * connection — never fires. The panel stays lit, responsive, and silent.
 * A warm restart hid it: with the network up the probe was slow enough to
 * lose the race.
 *
 * These tests pin the ordering guarantee rather than the symptom.
 */

type EventHandler = (e: { payload: unknown }) => void;

// Resolves, like the real `invoke` — `send` attaches a `.catch` to it.
const invoke = vi.fn((_channel: string, _args: { command: { type: string } }) =>
  Promise.resolve(),
);
// Held open so a test can decide exactly when registration completes —
// the whole point is what happens in that window.
let resolveListen: ((un: () => void) => void) | undefined;
const listen = vi.fn(
  (_channel: string, _handler: EventHandler) =>
    new Promise<() => void>((resolve) => (resolveListen = resolve)),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const { createTauriTransport } = await import("@/bus/tauriTransport");

/** Let queued promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockClear();
  listen.mockClear();
  resolveListen = undefined;
});

describe("tauriTransport", () => {
  it("holds commands until the event listener is registered", async () => {
    const transport = createTauriTransport();
    transport.onEvent(() => {});

    transport.send({ type: "connectivity:check" });
    await settle();

    // Registration is still in flight — the command must not have gone out,
    // because its reply would have nowhere to land.
    expect(invoke).not.toHaveBeenCalled();

    resolveListen?.(() => {});
    await settle();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves dispatch order across the gate", async () => {
    const transport = createTauriTransport();
    transport.onEvent(() => {});

    transport.send({ type: "connectivity:check" });
    transport.send({ type: "auth:check" });
    resolveListen?.(() => {});
    await settle();

    // A third command, sent once the gate is already open, still lands last.
    transport.send({ type: "ytdlp:check" });
    await settle();

    expect(invoke.mock.calls.map((c) => c[1].command.type)).toEqual([
      "connectivity:check",
      "auth:check",
      "ytdlp:check",
    ]);
  });

  it("re-arms the gate when the bus is torn down and remounted", async () => {
    const transport = createTauriTransport();
    const stop = transport.onEvent(() => {});
    resolveListen?.(() => {});
    await settle();

    stop();
    invoke.mockClear();

    // React's strict mode double-mount does exactly this. The second
    // subscription is a fresh round trip, so commands wait again rather
    // than going out against a listener that was just unlistened.
    transport.onEvent(() => {});
    transport.send({ type: "connectivity:check" });
    await settle();
    expect(invoke).not.toHaveBeenCalled();

    resolveListen?.(() => {});
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("delivers events to the handler once registered", async () => {
    const transport = createTauriTransport();
    const seen: unknown[] = [];
    transport.onEvent((e) => seen.push(e));
    resolveListen?.(() => {});
    await settle();

    listen.mock.calls[0][1]({ payload: { type: "net:status", online: true } });

    expect(seen).toEqual([{ type: "net:status", online: true }]);
  });
});
