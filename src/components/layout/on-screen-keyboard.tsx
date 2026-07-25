import { useEffect, useState } from "react";
import {
  ArrowBigUpIcon,
  CornerDownLeftIcon,
  DeleteIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Full-screen on-screen keyboard.
 *
 * Why in-app rather than the system one: nothing in this app ever summoned
 * a keyboard — WebKitGTK doesn't raise one on focus, and whether a desktop
 * OSK (squeekboard, onboard, wvkbd) appears at all depends on the Pi's
 * session configuration, which is outside this app's control and evidently
 * not working. An in-app keyboard is the only version that behaves the
 * same on every boot.
 *
 * Full-screen deliberately: on a 440px-tall panel a keyboard docked to the
 * bottom would leave a sliver of app above it and keys too small to hit.
 * Taking the whole screen buys 4 rows of genuinely finger-sized keys plus
 * a preview of what's being typed.
 *
 * Text is owned by the caller (`value`/`onChange`), so the real `<input>`
 * stays the single source of truth and everything downstream — debounced
 * search, the clear button — keeps working untouched.
 */

const ROWS_LOWER = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const ROWS_SYMBOL = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'],
  [".", ",", "?", "!", "'", "#", "%", "+", "*"],
  ["=", "_", "<", ">", "[", "]", "~"],
];

const KEY =
  "flex h-16 min-w-16 flex-1 items-center justify-center rounded-lg bg-white/10 text-2xl font-medium text-foreground transition-colors active:bg-white/25 hover:bg-white/15";
const WIDE =
  "flex h-16 items-center justify-center gap-2 rounded-lg bg-white/10 px-5 text-lg font-medium text-foreground transition-colors active:bg-white/25 hover:bg-white/15";

export function OnScreenKeyboard({
  value,
  onChange,
  onSubmit,
  onClose,
  placeholder,
}: {
  value: string;
  /** React-style updater, NOT a plain value. The keyboard must never
   *  build the next string from the `value` prop it was rendered with:
   *  two taps inside one render pass would both read the same stale
   *  prop and the second would overwrite the first, silently dropping a
   *  character. Caught by typing five keys in one tick and getting one
   *  letter back. */
  onChange: (update: (prev: string) => string) => void;
  /** Enter — the caller runs the search and typically closes. */
  onSubmit: () => void;
  onClose: () => void;
  placeholder?: string;
}) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);

  // A physical keyboard keeps working while this is open — the Pi has one
  // plugged in half the time, and being forced to hunt-and-peck on screen
  // because a panel is showing would be worse than no panel.
  //
  // CAPTURE phase, and it swallows the event. The app's own shortcuts are
  // bubble-phase listeners on `window` registered when AppShell mounted —
  // i.e. before this one — so without capturing, typing the letter "l"
  // here would type an `l` AND throw the user into the karaoke stage.
  // Capture runs before any bubble-phase listener regardless of
  // registration order, so stopping propagation here is what actually
  // isolates typing from shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        onSubmit();
      } else if (e.key === "Backspace") {
        onChange((prev) => prev.slice(0, -1));
      } else if (e.key.length === 1) {
        const ch = e.key;
        onChange((prev) => prev + ch);
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [onChange, onSubmit, onClose]);

  const rows = symbols ? ROWS_SYMBOL : ROWS_LOWER;
  const press = (k: string) => {
    const ch = shift && !symbols ? k.toUpperCase() : k;
    onChange((prev) => prev + ch);
    // One-shot shift, like every phone keyboard.
    if (shift) setShift(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] p-3">
      {/* What you're typing, big enough to read at arm's length. */}
      <div className="flex shrink-0 items-center gap-3 px-1 pb-2">
        <div className="flex min-h-14 min-w-0 flex-1 items-center rounded-lg border border-input bg-white/5 px-4">
          <span
            className={cn(
              "truncate text-2xl",
              value ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {value || placeholder || "Type to search…"}
          </span>
          <span className="ml-0.5 inline-block h-7 w-0.5 animate-pulse bg-brand" />
        </div>
        <button
          type="button"
          aria-label="Close keyboard"
          onClick={onClose}
          className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-white/10 hover:bg-white/15"
        >
          <XIcon className="size-7" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex justify-center gap-2">
            {/* Shift and Backspace flank the last two rows, the way a
                physical layout puts them, so muscle memory transfers. */}
            {i === 3 && !symbols && (
              <button
                type="button"
                aria-label="Shift"
                aria-pressed={shift}
                onClick={() => setShift((s) => !s)}
                className={cn(WIDE, shift && "bg-brand text-white")}
              >
                <ArrowBigUpIcon className="size-6" />
              </button>
            )}
            {row.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                className={KEY}
              >
                {shift && !symbols ? k.toUpperCase() : k}
              </button>
            ))}
            {i === 3 && (
              <button
                type="button"
                aria-label="Backspace"
                onClick={() => onChange((prev) => prev.slice(0, -1))}
                className={WIDE}
              >
                <DeleteIcon className="size-6" />
              </button>
            )}
          </div>
        ))}

        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => setSymbols((s) => !s)}
            className={cn(WIDE, "w-32")}
          >
            {symbols ? "ABC" : "?123"}
          </button>
          <button
            type="button"
            aria-label="Space"
            onClick={() => onChange((prev) => prev + " ")}
            className={cn(KEY, "max-w-[40rem] flex-[6]")}
          >
            space
          </button>
          <button
            type="button"
            aria-label="Search"
            onClick={onSubmit}
            className={cn(WIDE, "w-40 bg-brand text-white hover:bg-brand/90")}
          >
            <CornerDownLeftIcon className="size-6" />
            Search
          </button>
        </div>
      </div>
    </div>
  );
}

