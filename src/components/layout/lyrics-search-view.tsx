import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { OnScreenKeyboard } from "@/components/layout/on-screen-keyboard";
import { usePlaybackStore } from "@/store/playbackStore";
import { useLyricsStore } from "@/store/lyricsStore";
import { SOURCE_LABELS, type LyricsSource } from "@/lib/lyrics/sources";
import { syncLevelOf, type SyncLevel } from "@/lib/lyrics/score";
import type { Lyrics } from "@/lib/lyrics/types";
import { cn } from "@/lib/utils";

/**
 * Search Lyrics — a full-screen, two-panel manual lookup, modelled on
 * Carlyrics' "Modify Search" screen (`_editor_layout` / `draw_search_editor`
 * in `Lyrics_Display.py`): Artist and Song fields stacked down the left,
 * the keyboard filling the right.
 *
 * Why it exists: the automatic search only ever knows the metadata
 * YouTube Music gave us, and when that metadata is wrong — a mis-tagged
 * upload, a romanised artist, a title with a channel name glued to it —
 * no amount of scoring can rescue it, because every source is being asked
 * the wrong question. This is the escape hatch: ask the right question by
 * hand.
 *
 * The screen has two phases, deliberately not shown at once on a 440px
 * panel: the editor, then the results. There is no room for both, and
 * splitting them means each gets targets big enough to hit while driving.
 */
export function LyricsSearchView({ onClose }: { onClose: () => void }) {
  const queue = usePlaybackStore((s) => s.queue);
  const index = usePlaybackStore((s) => s.index);
  const track = index >= 0 ? queue[index] : undefined;

  const searchStatus = useLyricsStore((s) => s.searchStatus);
  const search = useLyricsStore((s) => s.search);
  const cachedQuery = useLyricsStore((s) => s.searchQuery);

  /**
   * Whether to show the editor or jump straight back to the results.
   *
   * Reopening after picking a wrong result should land on the list, not on
   * the form — the user's next move is "try the one below it", and making
   * them re-run a six-source sweep to reach a list that is still in memory
   * was the whole complaint. `editing` lets them get back to the form
   * deliberately, via "Edit search".
   */
  const [editing, setEditing] = useState(false);

  // Seeded from the track, because the common case is a small correction
  // to metadata that is mostly right — retyping a whole Chinese title on
  // a touch keyboard to fix one wrong character would be its own problem.
  // Seeded from the last query when there is one, so going back to the
  // form shows what was actually searched rather than the track metadata
  // the user had already corrected.
  const [artist, setArtist] = useState(cachedQuery?.artist ?? track?.subtitle ?? "");
  const [title, setTitle] = useState(cachedQuery?.title ?? track?.title ?? "");
  const [active, setActive] = useState<"artist" | "title">("title");
  const [composing, setComposing] = useState("");
  // One caret per field, so switching fields returns you to where you were
  // rather than to the end. Seeded past the end and clamped on use, which
  // puts a freshly-focused field's caret after its prefilled text.
  const [artistCaret, setArtistCaret] = useState(Number.MAX_SAFE_INTEGER);
  const [titleCaret, setTitleCaret] = useState(Number.MAX_SAFE_INTEGER);

  const activeValue = active === "artist" ? artist : title;
  const caretPos = Math.min(
    active === "artist" ? artistCaret : titleCaret,
    activeValue.length,
  );
  const setCaretPos = active === "artist" ? setArtistCaret : setTitleCaret;

  /** Focus a field and put the caret at `pos` in one go. */
  const focusField = (field: "artist" | "title", pos: number) => {
    setActive(field);
    setComposing("");
    if (field === "artist") setArtistCaret(pos);
    else setTitleCaret(pos);
  };

  // Closing no longer discards the results — that is what makes reopening
  // instant. They are cleared when the TRACK changes (see `load`), which
  // is when they actually stop being about the right song.
  const close = useCallback(() => onClose(), [onClose]);

  /**
   * Leave when the track does.
   *
   * A song ending while this is open leaves the user editing a query for a
   * song that stopped playing, over a keyboard whose results the store has
   * already discarded — and every lyric they could pick would be applied
   * to whatever is playing NOW. Dropping back to the karaoke stage is both
   * the safe outcome and the one they'd have chosen: the reason to be here
   * was the song they were listening to.
   *
   * Keyed on the videoId captured at mount rather than on a change event,
   * so it survives re-renders and fires exactly once, on the transition.
   */
  const openedForRef = useRef(track?.videoId);
  useEffect(() => {
    if (track?.videoId !== openedForRef.current) close();
  }, [track?.videoId, close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const ready = title.trim().length > 0;
  const runSearch = () => {
    if (!ready) return;
    setEditing(false);
    search({ title: title.trim(), artist: artist.trim() || undefined });
  };

  const haveResults = searchStatus === "done" || searchStatus === "error";
  if (haveResults && !editing) {
    return (
      <ResultsView
        onBack={() => setEditing(true)}
        onClose={close}
        query={{ title, artist }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex bg-[#0a0a0a]">
      {/* Left column — Carlyrics puts the fields at 40% of the width, which
          on this 1920px panel leaves the keyboard a comfortable 1100px. */}
      <div className="flex w-[38%] shrink-0 flex-col gap-3 p-4">
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={close}
            className="flex h-14 shrink-0 items-center gap-2 rounded-lg bg-white/10 px-5 text-lg font-medium hover:bg-white/15"
          >
            <XIcon className="size-6" />
            Back
          </button>
          {/* Only when there is a list to go back TO. Reached by tapping
              "Edit search" on the results, so the trip is reversible
              without paying for another sweep. */}
          {haveResults ? (
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="flex h-14 shrink-0 items-center gap-2 rounded-lg bg-white/10 px-5 text-lg font-medium hover:bg-white/15"
            >
              <ListIcon className="size-6" />
              Results
            </button>
          ) : (
            <span className="truncate text-lg text-muted-foreground">
              Search lyrics
            </span>
          )}
        </div>

        <Field
          label="Artist"
          value={artist}
          composing={active === "artist" ? composing : ""}
          active={active === "artist"}
          caret={Math.min(artistCaret, artist.length)}
          onFocusAt={(pos) => focusField("artist", pos)}
        />
        <Field
          label="Song"
          value={title}
          composing={active === "title" ? composing : ""}
          active={active === "title"}
          caret={Math.min(titleCaret, title.length)}
          onFocusAt={(pos) => focusField("title", pos)}
        />

        {/* Song is required, artist optional — searching by title alone is
            a legitimate query, and often the right one when the artist
            field is what was wrong in the first place. */}
        <button
          type="button"
          onClick={runSearch}
          disabled={!ready || searchStatus === "searching"}
          className={cn(
            "flex min-h-16 shrink-0 items-center justify-center gap-3 rounded-xl text-xl font-semibold transition-colors",
            ready
              ? "bg-brand text-white hover:bg-brand/90"
              : "bg-white/5 text-muted-foreground",
          )}
        >
          {searchStatus === "searching" ? (
            <SearchProgress />
          ) : (
            <>
              <SearchIcon className="size-6" />
              Search
            </>
          )}
        </button>
      </div>

      <div className="min-w-0 flex-1">
        <OnScreenKeyboard
          embedded
          value={activeValue}
          onChange={(update) =>
            active === "artist" ? setArtist(update) : setTitle(update)
          }
          onComposingChange={setComposing}
          onSubmit={runSearch}
          onClose={close}
          caret={{ pos: caretPos, set: setCaretPos }}
          // The left column already has a large Search button directly
          // under the fields it acts on; a second one in the keyboard's
          // corner was the same action twice, and the easier of the two to
          // hit by accident while typing.
          showSubmitKey={false}
        />
      </div>
    </div>
  );
}

function SearchProgress() {
  const { done, total } = useLyricsStore((s) => s.searchProgress);
  return (
    <>
      <Loader2Icon className="size-6 animate-spin" />
      {/* Naming the count matters here: a sweep of six sources includes
          Genius page scrapes and can take several seconds, and a bare
          spinner for that long reads as a hang. */}
      {total > 0 ? `Searching… ${done}/${total}` : "Searching…"}
    </>
  );
}

/**
 * One editable field.
 *
 * Rendered as a row of per-character spans rather than a single text node,
 * because that is what makes "tap where you want the caret" possible at
 * all: each character is its own hit target, and which half of it was
 * struck decides whether the caret lands before or after. A plain `<input>`
 * would give this for free in a browser, but on the Pi nothing ever
 * summons a keyboard and the real input is the on-screen one — so the
 * field has to be a display surface that reports taps.
 *
 * Not a `<button>` any more: nesting the per-character buttons inside one
 * would be invalid, and the outer element is a container, not a control.
 */
function Field({
  label,
  value,
  composing,
  active,
  caret,
  onFocusAt,
}: {
  label: string;
  value: string;
  composing: string;
  active: boolean;
  /** Caret index within `value`, already clamped. */
  caret: number;
  onFocusAt: (pos: number) => void;
}) {
  const chars = Array.from(value);
  // The caret is an index into UTF-16 code units (that is what `slice`
  // uses), but rendering walks code POINTS so an emoji or a surrogate pair
  // is one target rather than two broken halves. This maps between them.
  const offsetOf = (charIndex: number) =>
    chars.slice(0, charIndex).join("").length;

  return (
    <div
      onPointerDown={(e) => {
        // A tap on the field's padding — not on any character — puts the
        // caret at the end, which is what tapping "after the text" means.
        if ((e.target as HTMLElement).closest("[data-char]")) return;
        onFocusAt(value.length);
      }}
      className={cn(
        "flex min-h-20 shrink-0 cursor-text flex-col justify-center rounded-xl border-2 px-4 text-left transition-colors",
        active
          ? "border-brand bg-white/10"
          : "border-hairline bg-white/5 hover:bg-white/10",
      )}
    >
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="flex min-w-0 items-baseline overflow-hidden whitespace-pre text-2xl font-medium">
        {/* Caret before the first character. */}
        <Caret shown={active && caret === 0} />
        {chars.map((ch, i) => {
          const start = offsetOf(i);
          const end = start + ch.length;
          return (
            <span
              key={i}
              data-char
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                // Left half → before this character, right half → after.
                // Same rule every text field uses, and the one that makes
                // both edges of a character reachable.
                const before = e.clientX - r.left < r.width / 2;
                onFocusAt(before ? start : end);
              }}
              className="cursor-text"
            >
              {ch}
              {active && caret === end ? <Caret shown /> : null}
            </span>
          );
        })}
        {/* Un-converted Pinyin shows in the field being typed into, not in
            the keyboard — the underline has to appear where the text is
            going or it reads as a separate thing. */}
        {composing ? (
          <span className="shrink-0 text-brand underline decoration-brand/60 underline-offset-4">
            {composing}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The blinking insertion point. Zero-width so it sits BETWEEN characters
 *  instead of pushing them apart as it appears and disappears. */
function Caret({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <span
      aria-hidden
      className="relative inline-block h-7 w-0 align-middle"
    >
      <span className="absolute inset-y-0 -left-px w-0.5 animate-pulse bg-brand" />
    </span>
  );
}

/**
 * How each sync level is presented.
 *
 * The colours are the user's specification — yellow for line-by-line,
 * green for word-synced — and they carry real information: word-synced is
 * what makes the karaoke fill track the syllable being sung, so it is
 * worth reaching past a nearer line-synced result for. The label is shown
 * as well as the colour, because a colour alone is not a legend and this
 * is read at a glance in a car.
 */
const SYNC_STYLE: Record<SyncLevel, { box: string; chip: string; label: string }> = {
  word: {
    box: "border-emerald-500 bg-emerald-500/15 hover:bg-emerald-500/25",
    chip: "bg-emerald-500 text-black",
    label: "Word sync",
  },
  line: {
    box: "border-amber-400 bg-amber-400/15 hover:bg-amber-400/25",
    chip: "bg-amber-400 text-black",
    label: "Line sync",
  },
  plain: {
    box: "border-hairline bg-white/5 hover:bg-white/10",
    chip: "bg-white/20 text-foreground",
    label: "No timing",
  },
};

/** Eight per page, in two rows of four. Same reason the Pinyin candidate
 *  bar is paged rather than scrolled: WebKitGTK dispatches no touch events
 *  to the webview, so a scrolling list on this panel cannot be scrolled by
 *  finger at all — anything past the fold would simply be unreachable. */
const RESULTS_PER_PAGE = 8;

function ResultsView({
  onBack,
  onClose,
  query,
}: {
  onBack: () => void;
  onClose: () => void;
  query: { title: string; artist: string };
}) {
  const results = useLyricsStore((s) => s.searchResults);
  const error = useLyricsStore((s) => s.searchError);
  const pickManual = useLyricsStore((s) => s.pickManual);

  // The playing song's own length, shown in the same m:ss form as each
  // result's. That is the comparison being made when scanning this list —
  // a lyric that runs 2:10 against a 4:30 song is the wrong song, whatever
  // its title says — and it only works if the number to compare against is
  // on screen. Live duration first, since the queue's metadata figure can
  // be missing or a rounded guess.
  const playingDuration = usePlaybackStore((s) => s.duration);
  const queue = usePlaybackStore((s) => s.queue);
  const index = usePlaybackStore((s) => s.index);
  const trackDuration = index >= 0 ? queue[index]?.duration : undefined;
  const songLength = formatClock(playingDuration || trackDuration);

  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(results.length / RESULTS_PER_PAGE));
  const shown = Math.min(page, pageCount - 1);
  const slice = results.slice(
    shown * RESULTS_PER_PAGE,
    shown * RESULTS_PER_PAGE + RESULTS_PER_PAGE,
  );

  const pick = (lyrics: Lyrics) => {
    pickManual(lyrics);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] p-3">
      <div className="flex shrink-0 items-center gap-3 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-14 shrink-0 items-center gap-2 rounded-lg bg-white/10 px-5 text-lg font-medium hover:bg-white/15"
        >
          <ChevronLeftIcon className="size-6" />
          Edit search
        </button>
        <span className="min-w-0 flex-1 truncate text-lg text-muted-foreground">
          {query.artist ? `${query.artist} — ${query.title}` : query.title}
          {songLength ? ` · ${songLength}` : ""}
          {results.length > 0 ? ` · ${results.length} result${results.length === 1 ? "" : "s"}` : ""}
        </span>
        {pageCount > 1 ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-base tabular-nums text-muted-foreground">
              {shown + 1}/{pageCount}
            </span>
            <button
              type="button"
              aria-label="Previous results"
              disabled={shown === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="flex size-14 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-25"
            >
              <ChevronLeftIcon className="size-7" />
            </button>
            <button
              type="button"
              aria-label="More results"
              disabled={shown >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="flex size-14 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-25"
            >
              <ChevronRightIcon className="size-7" />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-white/10 hover:bg-white/15"
        >
          <XIcon className="size-7" />
        </button>
      </div>

      {error ? (
        <Notice text={`Search failed: ${error}`} />
      ) : results.length === 0 ? (
        <Notice text="No source had lyrics matching that artist and song. Try just the song name, or the other spelling of the artist." />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-2 gap-2">
          {slice.map(({ candidate, score }, i) => {
            const level = syncLevelOf(candidate.lyrics);
            const style = SYNC_STYLE[level];
            return (
              <button
                key={`${candidate.source}-${shown}-${i}`}
                type="button"
                onClick={() => pick(candidate.lyrics)}
                className={cn(
                  "flex min-h-0 flex-col justify-center gap-1 rounded-xl border-2 px-3 py-2 text-left transition-colors",
                  style.box,
                )}
              >
                <span className="truncate text-xl font-semibold">
                  {candidate.title || "Untitled"}
                </span>
                <span className="truncate text-base text-muted-foreground">
                  {candidate.artist || "Unknown artist"}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold",
                      style.chip,
                    )}
                  >
                    {style.label}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {SOURCE_LABELS[candidate.source as LyricsSource] ??
                      candidate.source}
                    {" · "}
                    {describeLength(candidate.lyrics)}
                    {/* The match score, so a result that looks wrong can be
                        told apart from one that merely looks unfamiliar. */}
                    {" · "}
                    {Math.round(score * 100)}%
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-12 text-center text-xl text-muted-foreground">
      {text}
    </div>
  );
}

/** A lyric's own time span, or its line count when it has no timings —
 *  the cheapest sanity check against the song actually playing. Carlyrics
 *  shows the same thing in each picker cell's lower-left corner. */
function describeLength(lyrics: Lyrics): string {
  if (lyrics.kind === "plain") {
    const lines = lyrics.text.split("\n").filter((l) => l.trim()).length;
    return `${lines} lines`;
  }
  const last = lyrics.lines[lyrics.lines.length - 1];
  const end = last?.end ?? last?.start ?? 0;
  return formatClock(end) ?? `${lyrics.lines.length} lines`;
}

/** Seconds as `m:ss`, or null when there is no usable figure — so callers
 *  can fall back rather than print "0:00" for "we don't know yet". */
function formatClock(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Re-exported so the picker can show the same colour key. */
export { SYNC_STYLE };
