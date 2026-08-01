import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  LYRIC_COLORS,
  LYRIC_FONT_MAX,
  LYRIC_FONT_MIN,
  LYRIC_FONT_STEP,
  lyricColorCss,
  useSettingsStore,
  type LyricColorName,
  type LyricSlot,
} from "@/store/settingsStore";
import { cn } from "@/lib/utils";

/**
 * Font settings for the karaoke stage — a port of Carlyrics' settings panel
 * (`draw_settings` / `_settings_layout` in `Lyrics_Display.py`), with the
 * same four rows in the same order, the same 20–160px slider snapping to
 * 5px, the same colour-swatch grid and the same per-line Bold/Normal
 * toggle.
 *
 * Two deliberate departures, both forced by this panel rather than by
 * taste:
 *
 *  1. **Rows are one line, not two.** Carlyrics stacks the slider above the
 *     swatches inside a left 60% column with Bold in the right 40%. Four of
 *     those plus a Done button does not fit in 440px — it comes to ~432px
 *     before any padding. This panel is 1920 wide and short, so the same
 *     controls are laid out along a row instead, on a shared grid so every
 *     column lines up down the screen.
 *  2. **There is no Cancel, and no separate save.** Carlyrics live-previews
 *     edits against module globals and only writes `config.json` on Done.
 *     Every other setting in this app applies and persists on the spot
 *     (`useSettingsStore` is a `persist` store), and having one screen
 *     behave differently is worse than the lost undo. `Reset to defaults`
 *     covers the case Cancel was there for.
 *
 * No live lyric preview, for the same 440px reason: a stage tall enough to
 * be worth looking at would leave no room for the controls that change it.
 * The size is shown numerically instead, and the stage is one tap away.
 */
export function FontSettings({ onClose }: { onClose: () => void }) {
  const reset = useSettingsStore((s) => s.resetLyricStyle);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] text-foreground">
      <header className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-3">
        <h1 className="text-2xl font-semibold">Font settings</h1>
        <span className="min-w-0 flex-1 truncate text-base text-white/45">
          Size, colour and weight for each line of the karaoke stage.
        </span>
        <button
          type="button"
          onClick={reset}
          className="flex h-12 shrink-0 items-center gap-2 rounded-lg bg-white/10 px-4 text-base font-medium hover:bg-white/15"
        >
          <RotateCcwIcon className="size-5" />
          Reset
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-12 shrink-0 items-center gap-2 rounded-lg bg-brand px-5 text-base font-medium text-white hover:bg-brand/90"
        >
          <CheckIcon className="size-5" />
          Done
        </button>
        <button
          type="button"
          aria-label="Close without resetting"
          onClick={onClose}
          className="flex size-12 shrink-0 items-center justify-center rounded-lg hover:bg-white/10"
        >
          <XIcon className="size-6" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-5 pb-3">
        {/* Colour-only, and first — same position and same reasoning as
            Carlyrics' `karaoke` row: the sweep borrows the current line's
            font, size and weight, so it has nothing else to offer. */}
        <KaraokeRow />
        <SlotRow slot="top" label="Top line" />
        <SlotRow slot="current" label="Current line" />
        <SlotRow slot="bottom" label="Bottom line" />
      </div>
    </div>
  );
}

/** One grid, shared by every row, so the sliders / swatches / Bold buttons
 *  line up in columns down the screen rather than drifting with each row's
 *  label width. */
const ROW_GRID = "grid grid-cols-[260px_1fr_auto_128px] items-center gap-4";

function KaraokeRow() {
  const value = useSettingsStore((s) => s.lyricStyle.karaoke);
  const set = useSettingsStore((s) => s.setKaraokeColor);
  return (
    <div className={cn(ROW_GRID, "py-1")}>
      <div className="flex flex-col">
        <span className="text-lg font-medium leading-tight">Karaoke fill</span>
        <span className="text-sm leading-tight text-white/45">sung words</span>
      </div>
      <div />
      <Swatches value={value} onPick={set} label="Karaoke fill colour" />
      <div />
    </div>
  );
}

function SlotRow({ slot, label }: { slot: LyricSlot; label: string }) {
  const style = useSettingsStore((s) => s.lyricStyle[slot]);
  const setSize = useSettingsStore((s) => s.setLyricSlotSize);
  const setColor = useSettingsStore((s) => s.setLyricSlotColor);
  const toggleBold = useSettingsStore((s) => s.toggleLyricSlotBold);

  return (
    <div className={cn(ROW_GRID, "py-1")}>
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-medium">{label}</span>
        <span className="text-base tabular-nums text-white/45">
          {style.size}px
        </span>
      </div>

      <input
        type="range"
        min={LYRIC_FONT_MIN}
        max={LYRIC_FONT_MAX}
        step={LYRIC_FONT_STEP}
        value={style.size}
        onChange={(e) => setSize(slot, Number(e.target.value))}
        aria-label={`${label} font size in pixels`}
        className="h-3 min-w-0 accent-brand"
      />

      <Swatches
        value={style.color}
        onPick={(c) => setColor(slot, c)}
        label={`${label} colour`}
      />

      {/* Carlyrics gives this its own column so the slider's generous
          vertical hit zone can never swallow a tap meant for Bold. Same
          split here, for the same reason. */}
      <button
        type="button"
        aria-pressed={style.bold}
        onClick={() => toggleBold(slot)}
        className={cn(
          "h-12 rounded-lg text-base transition-colors",
          style.bold
            ? "bg-[#285a8c] font-bold text-white"
            : "bg-white/10 font-medium text-white/70 hover:bg-white/15",
        )}
      >
        {style.bold ? "Bold" : "Normal"}
      </button>
    </div>
  );
}

/**
 * The palette. Swatches are 44px rather than Carlyrics' height-derived ~30px
 * — this build is only ever driven by a fingertip, and there is width to
 * spare on a 1920px panel.
 *
 * Every swatch carries a border whatever its state, or Black would be an
 * invisible hole in the panel's near-black background (Carlyrics hit this
 * too). The selected one gets a white ring outside that border.
 */
function Swatches({
  value,
  onPick,
  label,
}: {
  value: LyricColorName;
  onPick: (c: LyricColorName) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-3">
      {LYRIC_COLORS.map((c) => (
        <button
          key={c.name}
          type="button"
          role="radio"
          aria-checked={value === c.name}
          aria-label={c.label}
          title={c.label}
          onClick={() => onPick(c.name)}
          style={{ backgroundColor: lyricColorCss(c.name) }}
          className={cn(
            "size-11 shrink-0 rounded-lg border-2 border-white/25 transition-shadow",
            value === c.name &&
              "shadow-[0_0_0_3px_#0a0a0a,0_0_0_6px_rgb(255_255_255)]",
          )}
        />
      ))}
    </div>
  );
}
