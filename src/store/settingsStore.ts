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

/**
 * Karaoke-stage text palette, ported from Carlyrics' `SETTING_COLORS` with
 * its RGB values unchanged, plus two entries of our own:
 *
 *  - **brand** — `--brand` (#fa1f3e), so the shipped default sweep colour is
 *    expressible as a palette choice rather than a special case.
 *  - **grey** — Carlyrics' backdrop grey (110,110,110), which is very close
 *    to what the context lines and the unsung current line already composite
 *    to on the stage's #0a0a0a. It is the default for all three lines, so
 *    opening this screen and changing nothing leaves the stage as it was.
 *
 * Colours are applied at FULL opacity, like Carlyrics. The stage used to dim
 * each slot with an alpha (`text-foreground/35`, `text-muted-foreground/60`),
 * which would have turned every pick into a muted version of itself — picking
 * Yellow should give you Carlyrics' yellow. The dim resting state is
 * preserved by the *default* being grey, not by an alpha nobody can see.
 *
 * Safe to hardcode RGB despite the app's light/dark themes: the karaoke stage
 * is `bg-[#0a0a0a]` unconditionally (see `karaoke-view.tsx`), so these are
 * always drawn on near-black. Black is in the palette for parity with
 * Carlyrics, where it exists for light backdrops; here it is effectively
 * invisible, exactly as it is there on a dark one.
 */
export const LYRIC_COLORS = [
  { name: "brand", label: "Brand", rgb: [250, 31, 62] },
  { name: "yellow", label: "Yellow", rgb: [255, 220, 80] },
  { name: "green", label: "Green", rgb: [80, 220, 120] },
  { name: "white", label: "White", rgb: [235, 235, 235] },
  { name: "grey", label: "Grey", rgb: [110, 110, 110] },
  { name: "red", label: "Red", rgb: [255, 90, 90] },
  { name: "blue", label: "Blue", rgb: [110, 180, 255] },
  { name: "purple", label: "Purple", rgb: [200, 130, 255] },
  { name: "black", label: "Black", rgb: [0, 0, 0] },
  { name: "brown", label: "Brown", rgb: [165, 105, 60] },
] as const;

export type LyricColorName = (typeof LYRIC_COLORS)[number]["name"];

/** `rgb(...)` for a palette name. Falls back to the first entry rather than
 *  returning undefined, so a value persisted by an older build (or edited by
 *  hand) can never blank the stage. */
export function lyricColorCss(name: LyricColorName): string {
  const entry = LYRIC_COLORS.find((c) => c.name === name) ?? LYRIC_COLORS[0];
  const [r, g, b] = entry.rgb;
  return `rgb(${r} ${g} ${b})`;
}

/** Carlyrics' slider range and 5px snapping, unchanged. */
export const LYRIC_FONT_MIN = 20;
export const LYRIC_FONT_MAX = 160;
export const LYRIC_FONT_STEP = 5;

/** The three fixed stage slots. The karaoke sweep is deliberately NOT one:
 *  it is drawn in the current line's font, size and weight — only its colour
 *  is its own — so offering it a size or a weight would be a lie. Same
 *  reasoning as Carlyrics' `sized=False` row. */
export type LyricSlot = "top" | "current" | "bottom";

export interface LyricSlotStyle {
  /** Font size in px. */
  size: number;
  color: LyricColorName;
  bold: boolean;
}

export interface LyricStyle {
  /** Colour of the sung portion as the sweep crosses it. */
  karaoke: LyricColorName;
  top: LyricSlotStyle;
  current: LyricSlotStyle;
  bottom: LyricSlotStyle;
}

/**
 * Defaults chosen to reproduce what the stage rendered before this setting
 * existed, on the 1920x440 panel this is built for: `--lyric-font` was
 * `clamp(1.75rem,15vh,3.75rem)`, which at 440px tall clamps to its 60px
 * maximum, and the context lines were 0.61x that (Carlyrics' 34px against
 * 56) — 36.6, rounded to the slider's 5px grid at 35.
 *
 * The tradeoff of absolute px: the stage no longer scales with viewport
 * height, so a browser window of a different size gets a fixed size instead
 * of a fitted one. Accepted — the device is a fixed-size kiosk, Carlyrics
 * sizes in px for the same reason, and a size control whose value moves
 * under you is worse than one that doesn't.
 */
const DEFAULT_LYRIC_STYLE: LyricStyle = {
  karaoke: "brand",
  top: { size: 35, color: "grey", bold: false },
  current: { size: 60, color: "grey", bold: true },
  bottom: { size: 35, color: "grey", bold: false },
};

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
   *  beginning rather than where it was interrupted. On by default: the
   *  Pi boots straight into this app when the car starts, and the point
   *  of that is music, not a play button waiting to be found. Waits for a
   *  confirmed internet connection, not just for the app to mount — see
   *  `audioEngine.ts`. */
  resumeOnStartup: boolean;
  /** Keep playing past the end of the queue with tracks similar to the
   *  last one — the behaviour the YouTube Music app has, where starting
   *  one song from Listen Again turns into a station rather than stopping
   *  after three minutes. On by default, because that's what people
   *  expect from a music app and the alternative is silence in a moving
   *  car. */
  autoRadio: boolean;
  /** Per-slot size / colour / weight for the karaoke stage, plus the sweep
   *  colour. Consumed as CSS custom properties in `karaoke-view.tsx` and
   *  read back by `lyrics-view.tsx`. */
  lyricStyle: LyricStyle;
  setTheme: (theme: ThemeMode) => void;
  setLyricsOffsetSec: (v: number) => void;
  setResumeOnStartup: (v: boolean) => void;
  setAutoRadio: (v: boolean) => void;
  setLyricSlotSize: (slot: LyricSlot, px: number) => void;
  setLyricSlotColor: (slot: LyricSlot, color: LyricColorName) => void;
  toggleLyricSlotBold: (slot: LyricSlot) => void;
  setKaraokeColor: (color: LyricColorName) => void;
  resetLyricStyle: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      lyricsOffsetSec: 0,
      resumeOnStartup: true,
      autoRadio: true,
      lyricStyle: DEFAULT_LYRIC_STYLE,
      setTheme: (theme) => set({ theme }),
      // Clamp to ±3.0s and snap to 0.1s so persisted values and any
      // programmatic caller stay inside the slider's contract.
      setLyricsOffsetSec: (v) =>
        set({
          lyricsOffsetSec: Math.round(Math.min(3, Math.max(-3, v)) * 10) / 10,
        }),
      setResumeOnStartup: (resumeOnStartup) => set({ resumeOnStartup }),
      setAutoRadio: (autoRadio) => set({ autoRadio }),

      // Clamped and snapped here rather than trusting the slider, for the
      // same reason `setLyricsOffsetSec` is: the store's contract has to
      // hold for a rehydrated value too, not just for a drag.
      setLyricSlotSize: (slot, px) =>
        set((s) => ({
          lyricStyle: {
            ...s.lyricStyle,
            [slot]: {
              ...s.lyricStyle[slot],
              size: Math.min(
                LYRIC_FONT_MAX,
                Math.max(
                  LYRIC_FONT_MIN,
                  Math.round(px / LYRIC_FONT_STEP) * LYRIC_FONT_STEP,
                ),
              ),
            },
          },
        })),
      setLyricSlotColor: (slot, color) =>
        set((s) => ({
          lyricStyle: {
            ...s.lyricStyle,
            [slot]: { ...s.lyricStyle[slot], color },
          },
        })),
      toggleLyricSlotBold: (slot) =>
        set((s) => ({
          lyricStyle: {
            ...s.lyricStyle,
            [slot]: { ...s.lyricStyle[slot], bold: !s.lyricStyle[slot].bold },
          },
        })),
      setKaraokeColor: (karaoke) =>
        set((s) => ({ lyricStyle: { ...s.lyricStyle, karaoke } })),
      resetLyricStyle: () => set({ lyricStyle: DEFAULT_LYRIC_STYLE }),
    }),
    {
      name: "kl:settings",
      // v1 turns `resumeOnStartup` on. A default change alone would only
      // reach fresh installs — every device that has ever opened Settings
      // has the old `false` written to disk, including the Pi this is
      // built for. The migration adopts the new default once; turning it
      // back off in Settings sticks, because that write lands at v1.
      // v2 adds `lyricStyle`. A missing key would already fall back to the
      // default via persist's shallow merge, but a PARTIAL one would not —
      // the persisted object replaces the default wholesale, so a shape
      // written by a build with fewer slots would leave `lyricStyle.bottom`
      // undefined and the stage reading `.size` off it. Rebuild it slot by
      // slot instead of trusting what was on disk.
      version: 2,
      migrate: (persisted, version) => {
        const s = persisted as Partial<SettingsState>;
        const next = version < 1 ? { ...s, resumeOnStartup: true } : { ...s };
        const stored = next.lyricStyle as Partial<LyricStyle> | undefined;
        next.lyricStyle = {
          karaoke: stored?.karaoke ?? DEFAULT_LYRIC_STYLE.karaoke,
          top: { ...DEFAULT_LYRIC_STYLE.top, ...stored?.top },
          current: { ...DEFAULT_LYRIC_STYLE.current, ...stored?.current },
          bottom: { ...DEFAULT_LYRIC_STYLE.bottom, ...stored?.bottom },
        };
        return next;
      },
    },
  ),
);
