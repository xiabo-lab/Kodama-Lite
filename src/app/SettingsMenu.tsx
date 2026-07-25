import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  LogInIcon,
  LogOutIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  SettingsIcon,
  WifiIcon,
  WifiOffIcon,
  type LucideIcon,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dispatch } from "@/bus/bus";
import { useAppStore } from "@/store/appStore";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";

/**
 * The title bar's "…" menu. Everything in here is a setting that actually
 * does something today — account, sidebar rail, full screen, and a manual
 * connectivity re-check — rather than a settings *screen* full of
 * placeholders. YTMLite's fuller preferences page (themes, lyric sources,
 * playback quality) isn't ported; when it is, this menu is where it gets
 * its entry point.
 *
 * Built as a plain anchored panel with the same click-outside/Escape
 * handling as the queue panel, for the same reason: no `@radix-ui/*`
 * dependency in this project yet.
 */
export function SettingsMenu({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(className, open && "text-foreground")}
      >
        <MoreHorizontalIcon />
      </button>
      {open && <SettingsPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const online = useAppStore((s) => s.online);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const navigate = useAppStore((s) => s.navigate);

  const status = useAuthStore((s) => s.status);
  const account = useAuthStore((s) => s.account);
  const error = useAuthStore((s) => s.error);
  const signIn = useAuthStore((s) => s.signIn);
  const signOut = useAuthStore((s) => s.signOut);
  const signedIn = status === "signed-in";

  const { fullscreen, toggleFullscreen, supported } = useFullscreen();

  return (
    <div
      role="menu"
      // Left-anchored rather than centered: the "…" button sits in a
      // centered nav cluster, so a centered panel would overhang the
      // window's left edge on a narrow one.
      // Capped and scrollable for the same reason the source picker is:
      // the panel is a few rows away from being taller than a 440px
      // display, and it hangs downward from a 60px title bar.
      className="absolute left-0 top-full z-50 mt-1 flex max-h-[calc(100vh-5rem)] w-72 flex-col gap-1 overflow-y-auto rounded-xl border border-hairline bg-surface-active p-2 shadow-lg backdrop-blur"
    >
      <Section label="Account" />
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
        {signedIn && account?.avatar ? (
          <img
            src={account.avatar}
            alt=""
            referrerPolicy="no-referrer"
            className="size-7 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/10">
            <LogInIcon className="size-4 text-muted-foreground" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm">
          {status === "pending"
            ? "Signing in…"
            : signedIn
              ? (account?.name ?? "Signed in")
              : "Not signed in"}
        </span>
      </div>
      {error && (
        <p className="px-2 pb-1 text-xs text-brand" role="alert">
          {error}
        </p>
      )}
      <MenuItem
        icon={signedIn ? LogOutIcon : LogInIcon}
        label={signedIn ? "Sign out" : "Sign in to YouTube Music"}
        disabled={status === "pending"}
        onClick={() => {
          if (signedIn) signOut();
          else signIn();
          onClose();
        }}
      />

      <Divider />
      {/* This menu is the quick-access subset. Everything that needs room
          — theme, resume-on-startup, the lyrics offset slider — lives on
          the Settings screen; duplicating those controls here would mean
          two places to keep in step for no gain. */}
      <MenuItem
        icon={SettingsIcon}
        label="All settings"
        onClick={() => {
          navigate({ kind: "settings" });
          onClose();
        }}
      />

      <Divider />
      <Section label="Display" />
      <MenuItem
        icon={collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon}
        label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={toggleSidebar}
      />
      {supported && (
        <MenuItem
          icon={fullscreen ? MinimizeIcon : MaximizeIcon}
          label="Full screen"
          checked={fullscreen}
          onClick={toggleFullscreen}
        />
      )}

      <Divider />
      <Section label="Connection" />
      <MenuItem
        icon={online ? WifiIcon : WifiOffIcon}
        label={online ? "Online" : "Offline"}
        trailing={<RefreshCwIcon className="size-3.5" />}
        onClick={() => dispatch({ type: "connectivity:check" })}
      />

      <Divider />
      <p className="px-2 pb-0.5 pt-1 text-xs text-muted-foreground">
        Kodama-Lite {__APP_VERSION__}
      </p>
    </div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <h3 className="px-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
    </h3>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-hairline" aria-hidden="true" />;
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  checked,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  checked?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground/90 transition-colors hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? (
        <CheckIcon className="size-4 shrink-0 text-brand" />
      ) : (
        (trailing ?? null)
      )}
    </button>
  );
}

/**
 * Full-screen toggle over the Tauri window. Reports `supported: false` —
 * and renders nothing — outside a Tauri window, because in a plain browser
 * tab (the mock data plane) there is no window to resize and an item that
 * silently did nothing would be worse than an absent one. Importing the
 * module is harmless anywhere; it's `getCurrentWindow()` that needs the
 * guard, same as in karaoke-view.tsx.
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
    // Optimistic: the toggle is a local window operation, and reflecting it
    // immediately keeps the menu from feeling laggy on the Pi. Rolled back
    // if the call actually fails.
    setFullscreen(next);
    void getCurrentWindow()
      .setFullscreen(next)
      .catch(() => setFullscreen(!next));
  }, [fullscreen, supported]);

  return { fullscreen, supported, toggleFullscreen };
}
