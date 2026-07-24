import {
  CompassIcon,
  HouseIcon,
  Library as LibraryIcon,
  LogInIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { useAppStore, type Route } from "@/store/appStore";
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
 */
export function Sidebar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);

  return (
    <aside className="flex w-52 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar px-3 pb-3 pt-3">
      <span className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        Browse
      </span>
      {NAV.map(({ route: r, label, icon: Icon }) => (
        <button
          key={r.kind}
          onClick={() => navigate(r)}
          className={cn(
            "flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors",
            route.kind === r.kind
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <Icon className="size-5 shrink-0" />
          {label}
        </button>
      ))}

      <div className="mt-auto">
        <button className="flex w-full items-center justify-center gap-2 rounded-md bg-brand px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand/90">
          <LogInIcon className="size-4" />
          Sign in
        </button>
      </div>
    </aside>
  );
}
