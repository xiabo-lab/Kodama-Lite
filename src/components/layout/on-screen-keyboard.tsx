import { useEffect, useState } from "react";
import {
  ArrowBigUpIcon,
  CornerDownLeftIcon,
  DeleteIcon,
  EraserIcon,
  XIcon,
} from "lucide-react";
import { candidatesFor, loadPinyinDict, type Candidate } from "@/lib/pinyin";
import { cn } from "@/lib/utils";

/**
 * Full-screen on-screen keyboard, with a Pinyin input method.
 *
 * Why in-app rather than the system one: nothing in this app ever summoned
 * a keyboard — WebKitGTK raises none on focus, and whether a desktop OSK
 * (squeekboard, onboard, wvkbd) appears at all depends on the Pi's session
 * configuration, which is outside this app's control and evidently not
 * working. An in-app keyboard behaves the same on every boot.
 *
 * Full-screen deliberately: on a 440px-tall panel a docked keyboard leaves
 * a sliver of app above it and keys too small to hit.
 *
 * Text is owned by the caller (`value`/`onChange`), so the real `<input>`
 * stays the single source of truth and everything downstream — the
 * debounced search, the clear button — keeps working untouched.
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

// Heights are `h-full` inside flex-1 rows, NOT a fixed 64px. Fixed rows
// needed 496px on a 440px panel, so the key rows overflowed upward and
// physically overlapped the candidate bar — tapping a Chinese candidate
// also hit the number key sitting under it. Letting the rows divide
// whatever height is left makes overlap impossible at any screen size.
const KEY =
  "flex h-full min-w-14 flex-1 items-center justify-center rounded-lg bg-white/10 text-2xl font-medium text-foreground transition-colors active:bg-white/25 hover:bg-white/15";
// Shift and Backspace are wider than a letter key — the two most-used
// non-letters and the easiest to fat-finger into a neighbour.
const MOD_KEY =
  "flex h-full w-36 shrink-0 items-center justify-center gap-2 rounded-lg bg-white/10 text-lg font-medium text-foreground transition-colors active:bg-white/25 hover:bg-white/15";
const WIDE =
  "flex h-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 text-lg font-medium text-foreground transition-colors active:bg-white/25 hover:bg-white/15";

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
   *  two taps inside one render pass would both read the same stale prop
   *  and the second would overwrite the first, silently dropping a
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
  const [chinese, setChinese] = useState(false);
  /** Pinyin letters typed but not yet turned into characters. */
  const [composing, setComposing] = useState("");
  const [dict, setDict] = useState<Record<string, string> | null>(null);
  const [dictError, setDictError] = useState(false);

  // Fetched only when Chinese is actually switched on — see lib/pinyin.ts
  // for why the dictionary isn't part of the bundle.
  useEffect(() => {
    if (!chinese || dict) return;
    let cancelled = false;
    loadPinyinDict()
      .then((d) => !cancelled && setDict(d))
      .catch(() => !cancelled && setDictError(true));
    return () => {
      cancelled = true;
    };
  }, [chinese, dict]);

  const candidates: Candidate[] =
    chinese && dict && composing ? candidatesFor(composing, dict) : [];

  const commit = (c: Candidate) => {
    onChange((prev) => prev + c.text);
    setComposing((prev) => prev.slice(c.consumed));
  };

  const typeLetter = (ch: string) => {
    if (chinese && /^[a-z]$/i.test(ch)) {
      setComposing((prev) => prev + ch.toLowerCase());
      return;
    }
    onChange((prev) => prev + ch);
  };

  const backspace = () => {
    // Composing buffer first — deleting a letter you haven't converted yet
    // should not eat the text you already committed.
    if (composing) {
      setComposing((prev) => prev.slice(0, -1));
      return;
    }
    onChange((prev) => prev.slice(0, -1));
  };

  const clearAll = () => {
    setComposing("");
    onChange(() => "");
  };

  const submit = () => {
    // A pending buffer means the user is mid-word; take the best candidate
    // rather than throwing away what they typed.
    if (composing && candidates.length) {
      commit(candidates[0]);
      return;
    }
    setComposing("");
    onSubmit();
  };

  // A physical keyboard keeps working while this is open — the Pi has one
  // plugged in half the time.
  //
  // CAPTURE phase, and it swallows the event. The app's own shortcuts are
  // bubble-phase listeners on `window` registered when AppShell mounted —
  // i.e. before this one — so without capturing, typing the letter "l"
  // here would type an `l` AND throw the user into the karaoke stage.
  // Capture runs before any bubble-phase listener regardless of
  // registration order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") submit();
      else if (e.key === "Backspace") backspace();
      else if (e.key === " " && composing && candidates.length) {
        commit(candidates[0]);
      } else if (e.key.length === 1) typeLetter(e.key);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  });

  const rows = symbols ? ROWS_SYMBOL : ROWS_LOWER;
  const press = (k: string) => {
    typeLetter(shift && !symbols && !chinese ? k.toUpperCase() : k);
    if (shift) setShift(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] p-3">
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
          {/* Un-converted pinyin, underlined the way every IME shows it,
              so it's clear these letters aren't part of the query yet. */}
          {composing ? (
            <span className="ml-1 shrink-0 text-2xl text-brand underline decoration-brand/60 underline-offset-4">
              {composing}
            </span>
          ) : null}
          <span className="ml-0.5 inline-block h-7 w-0.5 animate-pulse bg-brand" />
        </div>
        {/* Clear sits beside the field it clears, not down among the
            letters — it acts on the whole query, and next to Backspace it
            was an easy and expensive mis-tap. */}
        <button
          type="button"
          aria-label="Clear"
          onClick={clearAll}
          disabled={!value && !composing}
          className="flex h-14 shrink-0 items-center justify-center gap-2 rounded-lg bg-white/10 px-4 text-lg font-medium hover:bg-white/15 disabled:opacity-30"
        >
          <EraserIcon className="size-6" />
          Clear
        </button>
        <button
          type="button"
          aria-label="Close keyboard"
          onClick={onClose}
          className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-white/10 hover:bg-white/15"
        >
          <XIcon className="size-7" />
        </button>
      </div>

      {/* Candidate bar. Present but empty in Chinese mode so the keys
          below don't jump up and down as candidates come and go — a row
          that moves under a finger is worse than a row that's blank. */}
      {chinese ? (
        <div className="flex h-14 shrink-0 items-center gap-2 overflow-x-auto rounded-lg bg-white/5 px-2">
          {dictError ? (
            <span className="text-sm text-brand">
              Couldn't load the Pinyin dictionary.
            </span>
          ) : !dict ? (
            <span className="text-sm text-muted-foreground">
              Loading Pinyin…
            </span>
          ) : candidates.length ? (
            candidates.map((c, i) => (
              <button
                key={`${c.text}-${i}`}
                type="button"
                onClick={() => commit(c)}
                className="flex h-12 min-w-12 shrink-0 items-center justify-center rounded-lg bg-white/10 px-3 text-2xl transition-colors hover:bg-white/20 active:bg-white/25"
              >
                {c.text}
              </button>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">
              {composing ? "No match" : "Type pinyin, e.g. beijing"}
            </span>
          )}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex min-h-0 flex-1 justify-center gap-2">
            {i === 3 && !symbols && (
              <button
                type="button"
                aria-label="Shift"
                aria-pressed={shift}
                onClick={() => setShift((s) => !s)}
                disabled={chinese}
                className={cn(
                  MOD_KEY,
                  shift && "bg-brand text-white",
                  chinese && "opacity-30",
                )}
              >
                <ArrowBigUpIcon className="size-7" />
              </button>
            )}
            {row.map((k) => (
              <button key={k} type="button" onClick={() => press(k)} className={KEY}>
                {shift && !symbols && !chinese ? k.toUpperCase() : k}
              </button>
            ))}
            {i === 3 && (
              <button
                type="button"
                aria-label="Backspace"
                onClick={backspace}
                className={MOD_KEY}
              >
                <DeleteIcon className="size-7" />
              </button>
            )}
          </div>
        ))}

        <div className="flex min-h-0 flex-1 gap-2">
          {/* Language toggle in the far-left corner — the one key you reach
              for without looking, and a corner is the easiest target on the
              whole panel. */}
          <button
            type="button"
            aria-label="Chinese input"
            aria-pressed={chinese}
            onClick={() => {
              setChinese((c) => !c);
              setComposing("");
              setShift(false);
            }}
            className={cn(WIDE, "w-36 shrink-0 text-2xl", chinese && "bg-brand text-white")}
          >
            {chinese ? "中" : "EN"}
          </button>
          <button
            type="button"
            onClick={() => setSymbols((s) => !s)}
            className={cn(WIDE, "w-36 shrink-0")}
          >
            {symbols ? "ABC" : "?123"}
          </button>
          <button
            type="button"
            aria-label="Space"
            onClick={() =>
              composing && candidates.length
                ? commit(candidates[0])
                : onChange((prev) => prev + " ")
            }
            className={cn(KEY, "flex-1")}
          >
            space
          </button>
          <button
            type="button"
            aria-label="Search"
            onClick={submit}
            className={cn(WIDE, "w-40 shrink-0 bg-brand text-white hover:bg-brand/90")}
          >
            <CornerDownLeftIcon className="size-6" />
            Search
          </button>
        </div>
      </div>
    </div>
  );
}
