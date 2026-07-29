import { useEffect, useState } from "react";
import {
  ArrowBigUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
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
const PAGER_BTN =
  "flex size-12 shrink-0 items-center justify-center rounded-lg bg-white/10 text-foreground transition-colors hover:bg-white/20 active:bg-white/25 disabled:opacity-25";

/** Candidates per page in the Chinese bar. Nine fits the 1920px panel at
 *  this key size without crowding the pager, and matches the 1-9 row a
 *  physical IME numbers its candidates with. */
const CANDIDATES_PER_PAGE = 9;

/**
 * Where edits land.
 *
 * The keyboard used to only ever append to and truncate the END of the
 * string — `prev + ch` and `prev.slice(0, -1)`. Correcting "I Love You" to
 * "You" therefore meant deleting seven correct characters to reach the
 * wrong ones. A cursor makes the edit proportional to the mistake.
 *
 * The caller owns the cursor alongside the text, for the same reason it
 * owns the text: the two have to move together, and a field that is tapped
 * to reposition the caret is the caller's own UI.
 */
export type Caret = {
  /** Index into the string, 0..length. */
  pos: number;
  /**
   * Accepts an updater as well as a value, and the updater form is what
   * the edit operations use.
   *
   * Two taps landing in the same render pass both read the same `pos`
   * prop, so `set(pos + 1)` twice would advance the caret once while the
   * text advanced twice — the caret and the string would desync exactly as
   * far as the user typed fast. Relative updates (`set(p => p + 1)`)
   * compose instead. This is the same hazard `onChange` documents for the
   * text itself; the caret needed the same treatment and did not have it.
   */
  set: (next: number | ((prev: number) => number)) => void;
};

export function OnScreenKeyboard({
  value,
  onChange,
  onSubmit,
  onClose,
  placeholder,
  embedded = false,
  onComposingChange,
  submitLabel = "Search",
  caret,
  showSubmitKey = true,
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
  /**
   * Render as a panel that fills its parent instead of as a full-screen
   * overlay, and drop the built-in text field and Close button — the
   * caller is showing its own.
   *
   * This is what lets the Search Lyrics screen put Artist/Song fields on
   * the left and the keys on the right (Carlyrics' `_editor_layout`)
   * while reusing this component's Pinyin IME rather than growing a
   * second copy of it.
   */
  embedded?: boolean;
  /** Un-converted Pinyin, surfaced so an embedded caller can render it in
   *  whichever field is focused — the underline that says "these letters
   *  aren't part of the text yet" has to appear where the text is. */
  onComposingChange?: (composing: string) => void;
  /** Label on the Enter key. "Search" reads wrong when the key commits a
   *  field rather than running a query. */
  submitLabel?: string;
  /**
   * Insertion point. When absent the keyboard behaves as it always did —
   * append and truncate at the end — which is what the plain full-screen
   * search wants, since it has no field to tap into.
   */
  caret?: Caret;
  /**
   * Whether to draw the Enter/Search key.
   *
   * The Search Lyrics screen already has a large Search button of its own
   * in the left column, directly under the fields it acts on. A second one
   * in the corner of the keyboard was the same action twice, and the
   * keyboard's copy was the one more easily hit by accident mid-typing.
   */
  showSubmitKey?: boolean;
}) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const [chinese, setChinese] = useState(false);
  /** Pinyin letters typed but not yet turned into characters. */
  const [composing, setComposing] = useState("");
  const [dict, setDict] = useState<Record<string, string> | null>(null);
  const [dictError, setDictError] = useState(false);

  useEffect(() => {
    onComposingChange?.(composing);
  }, [composing, onComposingChange]);

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

  // Candidates are paged rather than scrolled. The bar was
  // `overflow-x-auto`, which on the Pi is unusable: WebKitGTK dispatches
  // no touch events for the webview (the same reason `useDragScroll`
  // exists), so a horizontally scrolling strip has no way to be scrolled
  // by finger at all — everything past the ninth candidate was
  // unreachable even once the dictionary held it.
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(candidates.length / CANDIDATES_PER_PAGE));
  // Every edit to the buffer resets to page 0 (see `typeLetter`/`backspace`)
  // because it produces a different candidate list. This clamp is the
  // safety net for the paths that don't, so a stale page index can never
  // render an empty bar.
  const shownPage = Math.min(page, pageCount - 1);
  const pageStart = shownPage * CANDIDATES_PER_PAGE;
  const pageCandidates = candidates.slice(pageStart, pageStart + CANDIDATES_PER_PAGE);

  /**
   * Insert `text` at the caret (or at the end when there is no caret) and
   * leave the caret after what was inserted.
   *
   * The caret index is clamped against `prev` inside the updater rather
   * than read from the `caret.pos` prop directly, for the same reason
   * `onChange` takes an updater at all: two taps inside one render pass
   * would both see the same stale value and the second would clobber the
   * first.
   */
  const insert = (text: string) => {
    if (!caret) {
      onChange((prev) => prev + text);
      return;
    }
    onChange((prev) => {
      const i = Math.max(0, Math.min(caret.pos, prev.length));
      return prev.slice(0, i) + text + prev.slice(i);
    });
    // Relative, NOT `caret.pos + text.length`. An earlier version computed
    // the new index inside the `onChange` updater and read it out
    // afterwards — but React defers updaters, so the value read was always
    // the initial one. The caret jumped to 0 after every edit and the next
    // backspace became a no-op.
    caret.set((p) => p + text.length);
  };

  const commit = (c: Candidate) => {
    insert(c.text);
    setComposing((prev) => prev.slice(c.consumed));
    setPage(0);
  };

  const typeLetter = (ch: string) => {
    if (chinese && /^[a-z]$/i.test(ch)) {
      setComposing((prev) => prev + ch.toLowerCase());
      setPage(0);
      return;
    }
    insert(ch);
  };

  const backspace = () => {
    // Composing buffer first — deleting a letter you haven't converted yet
    // should not eat the text you already committed.
    if (composing) {
      setComposing((prev) => prev.slice(0, -1));
      setPage(0);
      return;
    }
    if (!caret) {
      onChange((prev) => prev.slice(0, -1));
      return;
    }
    onChange((prev) => {
      const i = Math.max(0, Math.min(caret.pos, prev.length));
      if (i === 0) return prev; // nothing to the left of the caret
      return prev.slice(0, i - 1) + prev.slice(i);
    });
    // `max(0, …)` keeps this consistent with the no-op branch above: at
    // index 0 nothing was deleted, and the caret must not move either.
    caret.set((p) => Math.max(0, p - 1));
  };

  const moveCaret = (delta: number) => {
    if (!caret) return;
    caret.set((p) => Math.max(0, Math.min(value.length, p + delta)));
  };

  const clearAll = () => {
    setComposing("");
    setPage(0);
    onChange(() => "");
    caret?.set(0);
  };

  const submit = () => {
    // A pending buffer means the user is mid-word; take the first
    // candidate on the page they're looking at rather than throwing away
    // what they typed.
    if (composing && pageCandidates.length) {
      commit(pageCandidates[0]);
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
      const converting = composing && pageCandidates.length > 0;
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") submit();
      else if (e.key === "Backspace") backspace();
      else if (e.key === " " && converting) commit(pageCandidates[0]);
      // Mid-conversion the number row picks a candidate and the arrows
      // page, the way every desktop IME behaves. Outside conversion they
      // stay ordinary keys, so typing a digit into a query still works.
      else if (converting && /^[1-9]$/.test(e.key)) {
        const pick = pageCandidates[Number(e.key) - 1];
        if (!pick) return;
        commit(pick);
      } else if (converting && e.key === "ArrowRight") {
        setPage((p) => Math.min(pageCount - 1, p + 1));
      } else if (converting && e.key === "ArrowLeft") {
        setPage((p) => Math.max(0, p - 1));
      }
      // Outside conversion the arrows move the caret, which is what they
      // do in every other text field in the world.
      else if (e.key === "ArrowRight") moveCaret(1);
      else if (e.key === "ArrowLeft") moveCaret(-1);
      else if (e.key === "Home") caret?.set(0);
      else if (e.key === "End") caret?.set(value.length);
      else if (e.key === "Delete") {
        // Forward delete: remove the character to the RIGHT, caret stays.
        if (caret) {
          onChange((prev) => {
            const i = Math.max(0, Math.min(caret.pos, prev.length));
            return prev.slice(0, i) + prev.slice(i + 1);
          });
        }
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
    <div
      className={cn(
        "flex flex-col bg-[#0a0a0a] p-3",
        embedded ? "h-full w-full min-h-0" : "fixed inset-0 z-[60]",
      )}
    >
      {embedded ? null : (
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
      )}

      {/* Candidate bar. Present but empty in Chinese mode so the keys
          below don't jump up and down as candidates come and go — a row
          that moves under a finger is worse than a row that's blank. */}
      {chinese ? (
        <div className="flex h-14 shrink-0 items-center gap-2 rounded-lg bg-white/5 px-2">
          {dictError ? (
            <span className="text-sm text-brand">
              Couldn't load the Pinyin dictionary.
            </span>
          ) : !dict ? (
            <span className="text-sm text-muted-foreground">
              Loading Pinyin…
            </span>
          ) : candidates.length ? (
            <>
              {pageCandidates.map((c, i) => (
                <button
                  key={`${c.text}-${pageStart + i}`}
                  type="button"
                  onClick={() => commit(c)}
                  className="flex h-12 min-w-12 shrink-0 items-center justify-center rounded-lg bg-white/10 px-3 text-2xl transition-colors hover:bg-white/20 active:bg-white/25"
                >
                  {c.text}
                </button>
              ))}
              {/* Pager pinned right, and mounted whenever Chinese is on
                  rather than only when there's a second page — a control
                  that appears and disappears under a finger shifts the
                  candidates sideways mid-tap. `ml-auto` keeps it at the
                  edge no matter how few candidates the page holds. */}
              <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
                <span className="px-1 text-sm tabular-nums text-muted-foreground">
                  {shownPage + 1}/{pageCount}
                </span>
                <button
                  type="button"
                  aria-label="Previous candidates"
                  disabled={shownPage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className={PAGER_BTN}
                >
                  <ChevronLeftIcon className="size-6" />
                </button>
                <button
                  type="button"
                  aria-label="More candidates"
                  disabled={shownPage >= pageCount - 1}
                  onClick={() =>
                    setPage((p) => Math.min(pageCount - 1, p + 1))
                  }
                  className={PAGER_BTN}
                >
                  <ChevronRightIcon className="size-6" />
                </button>
              </div>
            </>
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
              composing && pageCandidates.length
                ? commit(pageCandidates[0])
                : insert(" ")
            }
            className={cn(KEY, "flex-1")}
          >
            space
          </button>
          {/* Caret movement. Only drawn when the caller actually owns a
              caret — without one they would be dead keys. Placed in the
              bottom-right corner, where the Enter key used to be, because
              that is the corner a thumb already reaches for. */}
          {caret ? (
            <>
              <button
                type="button"
                aria-label="Move cursor left"
                onClick={() => moveCaret(-1)}
                className={cn(WIDE, "w-24 shrink-0")}
              >
                <ChevronLeftIcon className="size-7" />
              </button>
              <button
                type="button"
                aria-label="Move cursor right"
                onClick={() => moveCaret(1)}
                className={cn(WIDE, "w-24 shrink-0")}
              >
                <ChevronRightIcon className="size-7" />
              </button>
            </>
          ) : null}
          {showSubmitKey ? (
            <button
              type="button"
              aria-label={submitLabel}
              onClick={submit}
              className={cn(WIDE, "w-40 shrink-0 bg-brand text-white hover:bg-brand/90")}
            >
              <CornerDownLeftIcon className="size-6" />
              {submitLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
