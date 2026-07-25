import {
  DatabaseIcon,
  LogInIcon,
  LogOutIcon,
  PaletteIcon,
  RotateCcwIcon,
  TimerIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  Group,
  SectionTitle,
  SegmentedControl,
  SettingRow,
  Switch,
} from "@/components/settings/primitives";
import { useSettingsStore, type ThemeMode } from "@/store/settingsStore";
import { useAuthStore } from "@/store/authStore";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Settings, ported from YTMLite's four-tab settings dialog. Kodama-Lite
 * renders it as a route rather than a modal: on a 440px-tall panel a
 * dialog with a tab rail down one side leaves almost no room for the
 * panel itself, and a full screen is both roomier and easier to hit.
 *
 * Account / Appearance / Playback / Lyrics timing are all here and all
 * live. Storage is present but honest — see `StorageSection`.
 */
export function Settings() {
  return (
    <div className="flex flex-col gap-2 px-6 pb-6 pt-3">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <AccountSection />
      <AppearanceSection />
      <PlaybackSection />
      <LyricsTimingSection />
      <StorageSection />
    </div>
  );
}

function AccountSection() {
  const status = useAuthStore((s) => s.status);
  const account = useAuthStore((s) => s.account);
  const error = useAuthStore((s) => s.error);
  const signIn = useAuthStore((s) => s.signIn);
  const signOut = useAuthStore((s) => s.signOut);
  const signedIn = status === "signed-in";

  return (
    <>
      <SectionTitle>Account</SectionTitle>
      <Group>
        <SettingRow
          icon={signedIn ? UserRoundIcon : LogInIcon}
          title={
            status === "pending"
              ? "Signing in…"
              : signedIn
                ? (account?.name ?? "Signed in")
                : "Not signed in"
          }
          description={
            error ??
            (signedIn
              ? "Your library, liked songs and personalised recommendations are available."
              : "Sign in to YouTube Music for your library, liked songs and personalised recommendations. Search, Explore and public playlists work without it.")
          }
          control={
            <button
              type="button"
              disabled={status === "pending"}
              onClick={signedIn ? signOut : signIn}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
            >
              {signedIn ? (
                <>
                  <LogOutIcon className="size-4" />
                  Sign out
                </>
              ) : (
                <>
                  <LogInIcon className="size-4" />
                  Sign in
                </>
              )}
            </button>
          }
        />
      </Group>
    </>
  );
}

function AppearanceSection() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <Group>
        <SettingRow
          icon={PaletteIcon}
          title="Theme"
          description="Choose light or dark. There's no “system” option — an in-car display has no desktop preference to follow."
          control={
            <SegmentedControl
              value={theme}
              onChange={setTheme}
              options={THEME_OPTIONS}
              ariaLabel="Theme"
            />
          }
        />
      </Group>
    </>
  );
}

function PlaybackSection() {
  const resumeOnStartup = useSettingsStore((s) => s.resumeOnStartup);
  const setResumeOnStartup = useSettingsStore((s) => s.setResumeOnStartup);
  return (
    <>
      <SectionTitle>Playback</SectionTitle>
      <Group>
        <SettingRow
          icon={RotateCcwIcon}
          title="Resume on startup"
          description="When the app launches, start playing the last track again — from the beginning, not from where it was interrupted. Built for the Pi, which boots straight into this app."
          control={
            <Switch
              checked={resumeOnStartup}
              onChange={setResumeOnStartup}
              ariaLabel="Resume playback on startup"
            />
          }
        />
      </Group>
    </>
  );
}

function LyricsTimingSection() {
  const offset = useSettingsStore((s) => s.lyricsOffsetSec);
  const setOffset = useSettingsStore((s) => s.setLyricsOffsetSec);
  const label = `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`;

  return (
    <>
      <SectionTitle>Lyrics timing</SectionTitle>
      <div className="flex flex-col gap-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <TimerIcon className="size-[18px] text-muted-foreground" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[15px] font-medium leading-none">
              Lyrics offset
            </span>
            <span className="text-[13px] text-muted-foreground">
              Shift the lyrics to line up with the audio you actually hear over
              Bluetooth. Positive delays the lyrics to match late audio;
              negative moves them earlier.
            </span>
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums">
            {label}
          </span>
        </div>

        <div className="flex items-center gap-3 pl-12">
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            −3.0s
          </span>
          <input
            type="range"
            min={-3}
            max={3}
            step={0.1}
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
            aria-label="Lyrics timing offset in seconds"
            className="h-3 min-w-0 flex-1 accent-brand"
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            +3.0s
          </span>
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(0)}
            className="min-h-11 shrink-0 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * YTMLite's Storage tab is a full cache manager: per-track cache listing,
 * a movable cache directory, cover-art stats, bulk delete and a scheduled
 * sweep that protects anything in your library. All of it is a UI over
 * seven Rust commands (`list_cache`, `get_cache_dir`, `set_cache_dir`,
 * `pick_cache_folder`, `delete_cache_entries`, `cover_cache_stats`,
 * `clear_cover_cache`) that Kodama-Lite's playback subsystem does not
 * expose — it caches streams, but has no inventory, no relocation and no
 * deletion API behind the bus.
 *
 * Rendering the controls anyway would mean shipping a folder picker that
 * picks nothing and a "Clear cache" button that frees nothing, so the
 * section says what's missing instead. This is the one part of "same as
 * YTMLite" that isn't.
 */
function StorageSection() {
  return (
    <>
      <SectionTitle>Storage</SectionTitle>
      <Group>
        <SettingRow
          icon={DatabaseIcon}
          title="Cache management isn't available yet"
          description="Downloaded tracks are cached automatically, but moving the cache folder, browsing what's in it and clearing it need data-plane commands that haven't been built here yet. Nothing on this screen would do anything, so there's nothing on it."
        />
      </Group>
    </>
  );
}
