import { describe, expect, it } from "vitest";
import { SCREEN_SAVER_DELAYS_MIN, useSettingsStore } from "@/store/settingsStore";

describe("screen saver delay", () => {
  it("defaults to 2 minutes", () => {
    expect(useSettingsStore.getState().screenSaverDelayMin).toBe(2);
  });

  it("offers exactly 1, 2, 5, 30 min and 1, 12, 24 hr", () => {
    expect([...SCREEN_SAVER_DELAYS_MIN]).toEqual([1, 2, 5, 30, 60, 720, 1440]);
  });

  it("accepts every offered step", () => {
    for (const min of SCREEN_SAVER_DELAYS_MIN) {
      useSettingsStore.getState().setScreenSaverDelayMin(min);
      expect(useSettingsStore.getState().screenSaverDelayMin).toBe(min);
    }
  });

  it("refuses anything else, leaving the last good value", () => {
    useSettingsStore.getState().setScreenSaverDelayMin(5);
    for (const bad of [0, 3, -1, 2.5, Number.NaN, 100000]) {
      useSettingsStore.getState().setScreenSaverDelayMin(bad);
      expect(useSettingsStore.getState().screenSaverDelayMin).toBe(5);
    }
  });
});
