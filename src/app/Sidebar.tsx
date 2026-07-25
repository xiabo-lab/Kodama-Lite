import {
  CompassIcon,
  HouseIcon,
  Library as LibraryIcon,
  Loader2Icon,
  LogInIcon,
  SearchIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useAppStore, type Route } from "@/store/appStore";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";

const NAV: { route: Route; label: string; icon: LucideIcon }[] = [
  { route: { kind: "home" }, label: "Home", icon: HouseIcon },
  { route: { kind: "explore" }, label: "Explore", icon: CompassIcon },
  { route: { kind: "search" }, label: "Search", icon: SearchIcon },
  { route: { kind: "library" }, label: "Library", icon: LibraryIcon },
];

/**
 * Left navigation, ported in look from YTMLite (no logo header — the nav
 * starts at the top, as on the Pi). Selecting an item is a Store navigate,
 * which is instant; screens themselves load their data via the bus.
 *
 * Two widths, driven by `appStore.sidebarCollapsed` (toggled from the title
 * bar): the full 13rem rail, and a 4rem icon-only rail for when the content
 * column needs the width. Collapsing is pure CSS on an unchanged tree — the
 * same buttons stay mounted, so nothing re-fetches and focus survives the
 * toggle.
 */
export function Sidebar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);

  const status = useAuthStore((s) => s.status);
  const account = useAuthStore((s) => s.account);
  const signIn = useAuthStore((s) => s.signIn);
  const signedIn = status === "signed-in";
  const pending = status === "pending";

  return (
    <aside
      // Deliberately NOT animated. A `transition-[width]` here looked nicer
      // and was a trap: a CSS transition only advances when frames are
      // being produced, so any stall (rAF throttling on an unfocused or
      // occluded window — the exact hazard bus.ts already carries a 100ms
      // fallback timer for) leaves the rail parked at its previous width
      // with the collapsed class applied. Caught in-browser: the class
      // said `w-16` while the computed width sat at 208px until the
      // transition was forcibly removed. Snapping can't get stuck.
      className={cn(
        "flex shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar pb-3 pt-3",
        collapsed ? "w-16 px-2" : "w-52 px-3",
      )}
    >
      {!collapsed && (
        <span className="px-2 pb-1 text-xs font-medium text-muted-foreground">
          Browse
        </span>
      )}
      {NAV.map(({ route: r, label, icon: Icon }) => (
        <button
          key={r.kind}
          onClick={() => navigate(r)}
          title={collapsed ? label : undefined}
          aria-label={label}
          className={cn(
            "flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors",
            collapsed ? "justify-center px-0" : "px-2",
            route.kind === r.kind
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <Icon className="size-5 shrink-0" />
          {!collapsed && label}
        </button>
      ))}

      {/* Signed in, this is a status chip, not a control — a plain div, so
          it isn't a button that looks pressable and does nothing. Signing
          out lives in the settings menu, deliberately one step away from a
          finger resting on the edge of a touch panel. */}
      <div className="mt-auto">
        {signedIn ? (
          <div
            title={collapsed ? (account?.name ?? "Signed in") : undefined}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md bg-accent py-2.5 text-sm font-medium text-accent-foreground",
              collapsed ? "px-0" : "px-3",
            )}
          >
            {account?.avatar ? (
              <img
                src={account.avatar}
                alt=""
                referrerPolicy="no-referrer"
                className="size-5 shrink-0 rounded-full object-cover"
              />
            ) : (
              <UserRoundIcon className="size-4 shrink-0" />
            )}
            {!collapsed && (
              <span className="truncate">{account?.name ?? "Signed in"}</span>
            )}
          </div>
        ) : (
          <button
            onClick={signIn}
            disabled={pending}
            title={collapsed ? "Sign in" : undefined}
            aria-label="Sign in"
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md bg-brand py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60",
              collapsed ? "px-0" : "px-3",
            )}
          >
            {pending ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin" />
            ) : (
              <LogInIcon className="size-4 shrink-0" />
            )}
            {!collapsed && (
              <span className="truncate">{pending ? "Signing in…" : "Sign in"}</span>
            )}
          </button>
        )}
      </div>
    </aside>
  );
}
