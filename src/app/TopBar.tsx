import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Maximize2Icon,
  MaximizeIcon,
  MinimizeIcon,
  PanelLeftIcon,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/store/appStore";
import { usePlaybackStore } from "@/store/playbackStore";
import { useKaraokeStore } from "@/store/karaokeStore";
import { cn } from "@/lib/utils";

/**
 * Custom title bar: five finger-sized (56px) controls, evenly spaced, on
 * the Pi's touch panel.
 *
 * There is deliberately no dropdown behind the "…" any more. It held an
 * account block, a sidebar toggle that duplicated the button beside it,
 * and a connection row — a second, smaller settings surface that had to be
 * kept in step with the real one. Now "…" simply goes to Settings, and the
 * two things worth reaching in one tap (full screen, sidebar) are buttons
 * in their own right.
 *
 * The karaoke stage is opened from the top-right corner (see
 * `KaraokeCornerButton`), not from the player bar's icon row.
 */
const NAV_BTN =
  "flex size-14 items-center justify-center rounded-md text-foreground/65 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-7";

export function TopBar() {
  const back = useAppStore((s) => s.back);
  const forward = useAppStore((s) => s.forward);
  const canGoBack = useAppStore((s) => s.index > 0);
  const canGoForward = useAppStore((s) => s.index < s.history.length - 1);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const { fullscreen, supported, toggleFullscreen } = useFullscreen();

  return (
    <header className="relative z-30 flex h-[60px] shrink-0 select-none items-center">
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-24">
        {supported && (
          <button
            className={NAV_BTN}
            aria-label={fullscreen ? "Exit full screen" : "Full screen"}
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
        )}
        {/* No settings button here: the sidebar has one, and two entry
            points to the same screen is one more than the row has room
            for. */}
        <button
          className={cn(NAV_BTN, collapsed && "text-foreground")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          onClick={toggleSidebar}
        >
          <PanelLeftIcon />
        </button>
        <button className={NAV_BTN} aria-label="Back" disabled={!canGoBack} onClick={back}>
          <ArrowLeftIcon />
        </button>
        <button className={NAV_BTN} aria-label="Forward" disabled={!canGoForward} onClick={forward}>
          <ArrowRightIcon />
        </button>
      </div>
      <div className="h-full flex-1" />
      <KaraokeCornerButton />
    </header>
  );
}

/**
 * Full-screen karaoke, in the top-right corner — the one screen you reach
 * for while driving, so it gets the corner: the easiest target on a touch
 * panel to hit without looking, because two edges stop your finger for you.
 * It used to be a 40px icon in the player bar's transport row, wedged
 * between Repeat and the lyrics-source mic, where it was both the hardest
 * of the eight to pick out and easy to mis-tap into Repeat.
 *
 * The button is deliberately much larger than its icon: 160x60, flush to
 * the top and right edges with no margin or rounding on that side, so the
 * literal corner pixel is inside the hit box and an over-shot tap still
 * lands. The icon sits inset from the edge for looks; the padding around
 * it is all target.
 */
function KaraokeCornerButton() {
  const hasTrack = usePlaybackStore((s) => s.index >= 0);
  const setKaraokeOpen = useKaraokeStore((s) => s.setOpen);

  return (
    <button
      type="button"
      aria-label="Full-screen lyrics"
      disabled={!hasTrack}
      onClick={() => setKaraokeOpen(true)}
      className="flex h-full w-40 shrink-0 items-center justify-end self-stretch rounded-bl-md pr-6 text-foreground/65 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      <Maximize2Icon className="size-9" />
    </button>
  );
}

/**
 * Full-screen toggle over the Tauri window. Reports `supported: false` —
 * and renders no button — outside a Tauri window, because in a plain
 * browser tab there is no window to resize and a control that silently did
 * nothing would be worse than an absent one. Importing the module is
 * harmless anywhere; it's `getCurrentWindow()` that needs the guard.
 */
function useFullscreen(): {
  fullscreen: boolean;
  supported: boolean;
  toggleFullscreen: () => void;
} {
  const supported =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [fullscreen, setFullscreen] = useState(true);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void getCurrentWindow()
      .isFullscreen()
      .then((value) => {
        if (!cancelled) setFullscreen(value);
      })
      .catch(() => {
        /* leave the optimistic default — the config boots full-screen */
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const toggleFullscreen = useCallback(() => {
    if (!supported) return;
    const next = !fullscreen;
    // Optimistic: reflecting it immediately keeps the button from feeling
    // laggy on the Pi. Rolled back if the call actually fails.
    setFullscreen(next);
    void getCurrentWindow()
      .setFullscreen(next)
      .catch(() => setFullscreen(!next));
  }, [fullscreen, supported]);

  return { fullscreen, supported, toggleFullscreen };
}
