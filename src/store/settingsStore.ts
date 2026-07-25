import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * App preferences, ported from YTMLite's `lib/store/settings.ts` and
 * trimmed to what Kodama-Lite can actually honour today.
 *
 * NOT ported: `closeAction` (no tray — this app is a kiosk that owns the
 * screen), `cacheAutoClean` / `lastCacheCleanAt` (the Storage tab's cache
 * manager needs seven Rust commands Kodama-Lite's playback subsystem
 * doesn't expose — see the Settings screen's own note), `background`
 * (no ambient-art backdrop here) and `playbackNotifications` (no desktop
 * session to notify into). Each of those would be a lie as a toggle: a
 * switch that persists a value nothing reads is worse than its absence.
 */

export type ThemeMode = "dark" | "light";

interface SettingsState {
  /** Only light/dark — no "system": there is no desktop preference to
   *  follow on an in-car display. */
  theme: ThemeMode;
  /** Lyrics-timing offset in seconds, −3.0…+3.0. Compensates for the
   *  Bluetooth latency between this app's playback clock and the car
   *  speakers: line selection uses `position − lyricsOffsetSec`, so a
   *  positive value holds the lyrics back to match delayed audio and a
   *  negative one pushes them ahead. Consumed in `lyrics-view.tsx`. */
  lyricsOffsetSec: number;
  /** Auto-play the last-played track when the app launches, from its
   *  beginning rather than where it was interrupted. Aimed at the in-car
   *  Pi, which boots straight into the app. */
  resumeOnStartup: boolean;
  /** Keep playing past the end of the queue with tracks similar to the
   *  last one — the behaviour the YouTube Music app has, where starting
   *  one song from Listen Again turns into a station rather than stopping
   *  after three minutes. On by default, because that's what people
   *  expect from a music app and the alternative is silence in a moving
   *  car. */
  autoRadio: boolean;
  setTheme: (theme: ThemeMode) => void;
  setLyricsOffsetSec: (v: number) => void;
  setResumeOnStartup: (v: boolean) => void;
  setAutoRadio: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      lyricsOffsetSec: 0,
      resumeOnStartup: false,
      autoRadio: true,
      setTheme: (theme) => set({ theme }),
      // Clamp to ±3.0s and snap to 0.1s so persisted values and any
      // programmatic caller stay inside the slider's contract.
      setLyricsOffsetSec: (v) =>
        set({
          lyricsOffsetSec: Math.round(Math.min(3, Math.max(-3, v)) * 10) / 10,
        }),
      setResumeOnStartup: (resumeOnStartup) => set({ resumeOnStartup }),
      setAutoRadio: (autoRadio) => set({ autoRadio }),
    }),
    { name: "kl:settings" },
  ),
);
