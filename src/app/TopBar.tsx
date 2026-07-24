import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
} from "lucide-react";
import { useAppStore } from "@/store/appStore";

/**
 * Custom title bar. Mirrors the latest YTMLite layout: the four nav
 * controls sit centered and finger-sized (56px) for the Pi's touch panel,
 * with the window-control area on the right. Back/forward are wired to the
 * Store's history stack (see appStore.ts); More/sidebar-toggle stay
 * cosmetic — there's no settings screen or collapsible sidebar yet.
 */
const NAV_BTN =
  "flex size-14 items-center justify-center rounded-md text-foreground/65 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-7";

export function TopBar() {
  const back = useAppStore((s) => s.back);
  const forward = useAppStore((s) => s.forward);
  const canGoBack = useAppStore((s) => s.index > 0);
  const canGoForward = useAppStore((s) => s.index < s.history.length - 1);

  return (
    <header className="relative z-30 flex h-[60px] shrink-0 select-none items-center">
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-24">
        <button className={NAV_BTN} aria-label="More">
          <MoreHorizontalIcon />
        </button>
        <button className={NAV_BTN} aria-label="Toggle sidebar">
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
    </header>
  );
}
