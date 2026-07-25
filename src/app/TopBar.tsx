import { ArrowLeftIcon, ArrowRightIcon, PanelLeftIcon } from "lucide-react";
import { SettingsMenu } from "@/app/SettingsMenu";
import { useAppStore } from "@/store/appStore";
import { cn } from "@/lib/utils";

/**
 * Custom title bar. Mirrors the latest YTMLite layout: the four nav
 * controls sit centered and finger-sized (56px) for the Pi's touch panel,
 * with the window-control area on the right. All four are wired: "…" opens
 * the settings menu, the panel icon collapses the sidebar to an icon rail,
 * and back/forward drive the Store's history stack (see appStore.ts).
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

  return (
    <header className="relative z-30 flex h-[60px] shrink-0 select-none items-center">
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-24">
        <SettingsMenu className={NAV_BTN} />
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
    </header>
  );
}
