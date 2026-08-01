import { useEffect, useState } from "react";
import {
  DatabaseIcon,
  InfoIcon,
  LogInIcon,
  LogOutIcon,
  MicVocalIcon,
  PaletteIcon,
  PowerIcon,
  RadioIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TimerIcon,
  Trash2Icon,
  TypeIcon,
  UserRoundIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import {
  Group,
  SectionTitle,
  SegmentedControl,
  SettingRow,
  Switch,
} from "@/components/settings/primitives";
import { FontSettings } from "@/components/settings/font-settings";
import { dispatch } from "@/bus/bus";
import { useAppStore } from "@/store/appStore";
import { useSettingsStore, type ThemeMode } from "@/store/settingsStore";
import { useAuthStore } from "@/store/authStore";
import { formatBytes, useCacheStore } from "@/store/cacheStore";
import { clearLyricsCache, lyricsCacheStats } from "@/store/lyricsStore";
import { cn } from "@/lib/utils";

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
    <div className="flex flex-col gap-2 px-6 pb-6 pt-2">
      <QuitSection />
      <AccountSection />
      <AppearanceSection />
      <PlaybackSection />
      <LyricsTimingSection />
      <StorageSection />
      <ConnectionSection />
      <AboutSection />
    </div>
  );
}

/**
 * Quit — the first row of the screen, because it's the one thing you come
 * here for that isn't a preference. The Pi runs this full-screen with no
 * window chrome and nothing behind it, so before this row the only way out
 * was an SSH session.
 *
 * Armed in two taps rather than one. Everything else on this screen is
 * reversible in a tap; this ends the session and stops the music, and the
 * screen it lives on is driven by a fingertip in a moving car. The armed
 * state expires by itself after 4s so a half-press never leaves a live
 * trigger sitting under the next stray touch.
 */
function QuitSection() {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [armed]);

  return (
    <>
      <SectionTitle>Power</SectionTitle>
      <Group>
        <SettingRow
          icon={PowerIcon}
          title="Quit Kodama-Lite"
          description={
            armed
              ? "Tap again to close the app. Playback stops immediately."
              : "Close the app. Playback stops; the queue and everything cached come back on the next launch."
          }
          control={
            <button
              type="button"
              onClick={() =>
                armed ? dispatch({ type: "app:quit" }) : setArmed(true)
              }
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors",
                armed
                  ? "bg-brand text-white hover:bg-brand/90"
                  : "border border-input hover:bg-accent",
              )}
            >
              <PowerIcon className="size-4" />
              {armed ? "Confirm quit" : "Quit"}
            </button>
          }
        />
      </Group>
    </>
  );
}

/**
 * Connectivity, moved here from the title bar's old dropdown. It's a
 * status readout with a manual re-check, which is a settings-screen thing
 * rather than something worth a permanent slot in the chrome.
 */
function ConnectionSection() {
  const online = useAppStore((s) => s.online);
  return (
    <>
      <SectionTitle>Connection</SectionTitle>
      <Group>
        <SettingRow
          icon={online ? WifiIcon : WifiOffIcon}
          title={online ? "Online" : "Offline"}
          description={
            online
              ? "Reachability is probed with a raw socket, not the OS's “a network exists” flag — so this reflects whether the internet actually answers."
              : "Cached screens and cached tracks keep working. Anything not already saved will retry once you're back."
          }
          control={
            <button
              type="button"
              onClick={() => dispatch({ type: "connectivity:check" })}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input px-4 text-sm font-medium transition-colors hover:bg-accent"
            >
              <RefreshCwIcon className="size-4" />
              Check now
            </button>
          }
        />
      </Group>
    </>
  );
}

function AboutSection() {
  return (
    <>
      <SectionTitle>About</SectionTitle>
      <Group>
        <SettingRow
          icon={InfoIcon}
          title={`Kodama-Lite ${__APP_VERSION__}`}
          description="A fluid YouTube Music client for the Raspberry Pi 5 in-car display."
        />
      </Group>
    </>
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
  const [fontOpen, setFontOpen] = useState(false);
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
        {/* Opens over the whole screen rather than expanding in place: it
            carries four rows of sliders and swatches, which is more than
            this list can hold without pushing everything below it out of
            reach. Same treatment as the lyrics search view. */}
        <SettingRow
          icon={TypeIcon}
          title="Font settings"
          description="Size, colour and weight for each line of the karaoke stage — the top and bottom context lines, the current line, and the colour that sweeps across the words as they're sung."
          control={
            <button
              type="button"
              onClick={() => setFontOpen(true)}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input px-4 text-sm font-medium transition-colors hover:bg-accent"
            >
              <TypeIcon className="size-4" />
              Font settings
            </button>
          }
        />
      </Group>
      {fontOpen ? <FontSettings onClose={() => setFontOpen(false)} /> : null}
    </>
  );
}

function PlaybackSection() {
  const resumeOnStartup = useSettingsStore((s) => s.resumeOnStartup);
  const setResumeOnStartup = useSettingsStore((s) => s.setResumeOnStartup);
  const autoRadio = useSettingsStore((s) => s.autoRadio);
  const setAutoRadio = useSettingsStore((s) => s.setAutoRadio);
  return (
    <>
      <SectionTitle>Playback</SectionTitle>
      <Group>
        <SettingRow
          icon={RotateCcwIcon}
          title="Resume on startup"
          description="When the app launches, start playing the last track again — from the beginning, not from where it was interrupted. It waits for the internet to actually answer first, so a car that starts before the hotspot does still ends up playing. Built for the Pi, which boots straight into this app."
          control={
            <Switch
              checked={resumeOnStartup}
              onChange={setResumeOnStartup}
              ariaLabel="Resume playback on startup"
            />
          }
        />
        <SettingRow
          icon={RadioIcon}
          title="Autoplay similar songs"
          description="When the queue runs out, keep playing with songs similar to the last one — the way the YouTube Music app turns a single track into a station instead of falling silent."
          control={
            <Switch
              checked={autoRadio}
              onChange={setAutoRadio}
              ariaLabel="Autoplay similar songs when the queue ends"
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
            <span className="text-[24px] font-medium leading-none">
              Lyrics offset
            </span>
            <span className="text-[24px] text-muted-foreground">
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
 * Storage. Both caches are real and both make a replayed track cost no
 * data: the stream server writes every played track to disk as
 * `<app-cache>/stream/<videoId>.webm` and serves later plays from it, and
 * `lyricsStore` keeps the full per-source lyrics map in localStorage.
 *
 * Smaller than YTMLite's tab, which also lists per-track entries by
 * title, relocates the cache directory and runs a scheduled sweep that
 * spares anything in your library. Those need a title sidecar, a folder
 * picker and a library round-trip; size-and-clear is the part that
 * answers "how much space is this using and how do I get it back".
 */
function StorageSection() {
  const count = useCacheStore((s) => s.count);
  const bytes = useCacheStore((s) => s.bytes);
  const dir = useCacheStore((s) => s.dir);
  const loading = useCacheStore((s) => s.loading);
  const refresh = useCacheStore((s) => s.refresh);
  const clearAudio = useCacheStore((s) => s.clear);

  const [lyrics, setLyrics] = useState(() => lyricsCacheStats());

  // Ask once when the screen mounts. Cheap (a directory stat), and the
  // numbers are stale the moment anything plays.
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <>
      <SectionTitle>Storage</SectionTitle>
      <Group>
        <SettingRow
          icon={DatabaseIcon}
          title="Cached audio"
          description={
            count === undefined
              ? "Checking…"
              : `${count} track${count === 1 ? "" : "s"} · ${formatBytes(bytes ?? 0)}. Played tracks are saved here automatically, so playing them again uses no data.${dir ? ` Stored in ${dir}.` : ""}`
          }
          control={
            <button
              type="button"
              disabled={loading || !count}
              onClick={clearAudio}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input px-4 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2Icon className="size-4" />
              Clear
            </button>
          }
        />
        <SettingRow
          icon={MicVocalIcon}
          title="Cached lyrics"
          description={`${lyrics.count} track${lyrics.count === 1 ? "" : "s"} · ${formatBytes(lyrics.bytes)}. Every source's lyrics are kept, so switching source on a saved track works offline too.`}
          control={
            <button
              type="button"
              disabled={!lyrics.count}
              onClick={() => {
                clearLyricsCache();
                setLyrics(lyricsCacheStats());
              }}
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-input px-4 text-sm font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2Icon className="size-4" />
              Clear
            </button>
          }
        />
      </Group>
    </>
  );
}
