import { create } from "zustand";
import { dispatch } from "@/bus/bus";
import { dispatchContent } from "@/lib/network";
import { useLibraryStore } from "@/store/libraryStore";
import { useLikedSongsStore } from "@/store/likedSongsStore";
import type { AppEvent } from "@/protocol";
import { resetAuthCache, setSession } from "@/lib/innertube/shared";
import { fetchAccount, type Account } from "@/lib/innertube/account";

/**
 * Accounts, view-plane half. Same shape as every other store here: clicking
 * "Sign in" is a synchronous local `set()` plus a fire-and-forget command,
 * and the answer arrives later as an `auth:state` event — nothing awaits,
 * nothing blocks a render, and the login window opening is the data plane's
 * problem (`src-tauri/src/subsystems/auth.rs`).
 *
 * The credentials themselves deliberately do NOT live in this store: they
 * go straight into `lib/innertube/shared.ts` via `setSession()`, the only
 * module that has any use for them. That keeps a live Google session out of
 * component props, out of devtools' store inspector, and out of the
 * `?debug=1` globals — the store carries only the boolean and the
 * cosmetic name/avatar.
 */

export type AuthStatus = "signed-out" | "pending" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  /** True once `auth:check` has been *answered*, either way.
   *
   *  `status` cannot express this: it starts at `"signed-out"`, which is
   *  also a legitimate settled answer, so "nobody has looked yet" and
   *  "looked, and there is no session" were indistinguishable. The Home
   *  startup refresh waits on this so it fetches the personalized feed
   *  rather than racing the cookie-jar read and fetching an anonymous one
   *  that is thrown away a moment later. */
  checked: boolean;
  account: Account | null;
  /** Last sign-in failure, cleared when a new attempt starts. */
  error: string | null;
  signIn: () => void;
  signOut: () => void;
  applyEvents: (events: AppEvent[]) => void;
}

/** Guards against a slow account fetch from an earlier session landing
 *  after a later sign-out and resurrecting the old name/avatar. */
let sessionEpoch = 0;

/**
 * Backoff schedule for the account-name fetch. A single attempt was the
 * bug: `account/account_menu` is the first authenticated request of the
 * session, so on the Pi it routinely goes out before the phone hotspot has
 * finished associating, returns nothing, and — because `fetchAccount`
 * swallows failures by design — leaves the sidebar reading "Signed in"
 * for the rest of the run with no way to ask again.
 *
 * That fallback also turned out to be a useful symptom: the same dead
 * window costs the personalized Home feed and the liked-songs sync. Those
 * have their own retries now, but the name is the visible one, so it's
 * worth getting right.
 */
const ACCOUNT_RETRY_MS = [1_000, 3_000, 8_000, 20_000, 60_000];

/**
 * Fetch the display name/avatar, retrying while the answer is empty.
 * Stops on the first result that carries a name, when the schedule runs
 * out, or as soon as the session it was started for is superseded.
 */
function loadAccount(epoch: number, attempt = 0): void {
  void fetchAccount().then((account) => {
    if (epoch !== sessionEpoch) return;
    // A partial answer (avatar, no name) still beats the generic chip, so
    // keep it — but keep asking, because the name is the point.
    if (account) useAuthStore.setState({ account });
    if (account?.name) return;
    const delay = ACCOUNT_RETRY_MS[attempt];
    if (delay === undefined) return;
    window.setTimeout(() => {
      if (epoch === sessionEpoch) loadAccount(epoch, attempt + 1);
    }, delay);
  });
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "signed-out",
  checked: false,
  account: null,
  error: null,

  signIn: () => {
    set({ status: "pending", error: null });
    dispatch({ type: "auth:signIn" });
  },

  signOut: () => {
    // Drop the credentials here and now rather than waiting for the event:
    // an in-flight InnerTube request must not be able to pick up the
    // `Cookie` header of an account the user has just signed out of.
    sessionEpoch++;
    resetAuthCache();
    useLibraryStore.getState().reset();
    useLikedSongsStore.getState().reset();
    set({ status: "signed-out", account: null, error: null });
    dispatch({ type: "auth:signOut" });
    dispatchContent({ type: "home:load" });
  },

  applyEvents: (events) => {
    for (const e of events) {
      if (e.type === "auth:state") {
        const epoch = ++sessionEpoch;
        const wasSignedIn = useAuthStore.getState().status === "signed-in";
        // Library content is per-account and never persisted — drop it on
        // any session change so one account's playlists can't paint under
        // another's name. Liked songs are the same: the heart state is
        // whose account it is.
        useLibraryStore.getState().reset();
        useLikedSongsStore.getState().reset();
        if (e.signedIn && e.cookie && e.sapisid) {
          setSession({ cookie: e.cookie, sapisid: e.sapisid });
          // Keep a name already on screen across a redundant `auth:check`
          // answer: blanking it to null here made the sidebar flicker back
          // to "Signed in" every time the cookie jar was re-read.
          const keep = wasSignedIn ? useAuthStore.getState().account : null;
          set({ status: "signed-in", checked: true, account: keep, error: null });
          // Cosmetic and non-blocking — the app is fully signed in the
          // moment the line above runs, whether or not this ever resolves.
          loadAccount(epoch);
          // Seed the heart state. Must come after `setSession`: the store
          // refuses to sync without a session, on purpose.
          useLikedSongsStore.getState().sync();
          // Home is the one feed whose contents differ between anonymous
          // and signed-in. Boot fetches it anonymously (the cookie jar
          // read is async, so it can't have landed first) — refetch now
          // that it's personalized. Guarded so a redundant `auth:check`
          // answer can't turn into a refetch loop.
          if (!wasSignedIn) dispatchContent({ type: "home:load" });
        } else {
          resetAuthCache();
          set({ status: "signed-out", checked: true, account: null });
          if (wasSignedIn) dispatchContent({ type: "home:load" });
        }
      } else if (e.type === "auth:error") {
        sessionEpoch++;
        resetAuthCache();
        set({ status: "signed-out", checked: true, account: null, error: e.message });
      }
    }
  },
}));
