import { describe, expect, it } from "vitest";
import { idleRemainingMs, screenSaverEligible } from "./idle";

describe("screenSaverEligible", () => {
  it("is Home and only Home", () => {
    expect(screenSaverEligible({ kind: "home" }, false, false)).toBe(true);
    for (const kind of ["explore", "search", "library", "settings"] as const) {
      expect(screenSaverEligible({ kind }, false, false)).toBe(false);
    }
    expect(screenSaverEligible({ kind: "playlist", id: "LM" }, false, false)).toBe(false);
  });

  it("never under the karaoke stage, which leaves the route on Home", () => {
    expect(screenSaverEligible({ kind: "home" }, true, false)).toBe(false);
  });

  it("not while the queue panel is open over Home", () => {
    expect(screenSaverEligible({ kind: "home" }, false, true)).toBe(false);
  });
});

describe("idleRemainingMs", () => {
  it("counts down from the last activity and stops at zero", () => {
    expect(idleRemainingMs(1000, 1000, 120_000)).toBe(120_000);
    expect(idleRemainingMs(1000, 61_000, 120_000)).toBe(60_000);
    expect(idleRemainingMs(1000, 500_000, 120_000)).toBe(0);
  });
});
