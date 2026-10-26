import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setCursorVisible = vi.fn<(_: boolean) => Promise<void>>();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setCursorVisible }),
}));

import { hideNativeCursor } from "@/lib/cursor";

const originalWindow = globalThis.window;

beforeEach(() => {
  setCursorVisible.mockReset();
  setCursorVisible.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
});

describe("hideNativeCursor", () => {
  it("is inert in the plain browser preview", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });

    await hideNativeCursor();
    expect(setCursorVisible).not.toHaveBeenCalled();
  });

  it("hides the native Tauri cursor", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { __TAURI_INTERNALS__: {} },
    });

    await hideNativeCursor();
    expect(setCursorVisible).toHaveBeenCalledOnce();
    expect(setCursorVisible).toHaveBeenCalledWith(false);
  });

  it("does not block startup if the compositor refuses the request", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
    setCursorVisible.mockRejectedValue(new Error("not supported"));

    await expect(hideNativeCursor()).resolves.toBeUndefined();
  });
});
