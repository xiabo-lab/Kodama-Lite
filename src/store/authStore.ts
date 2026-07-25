import { create } from "zustand";
import { dispatch } from "@/bus/bus";
import { dispatchContent } from "@/lib/network";
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

export const useAuthStore = create<AuthState>((set) => ({
  status: "signed-out",
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
    set({ status: "signed-out", account: null, error: null });
    dispatch({ type: "auth:signOut" });
    dispatchContent({ type: "home:load" });
  },

  applyEvents: (events) => {
    for (const e of events) {
      if (e.type === "auth:state") {
        const epoch = ++sessionEpoch;
        const wasSignedIn = useAuthStore.getState().status === "signed-in";
        if (e.signedIn && e.cookie && e.sapisid) {
          setSession({ cookie: e.cookie, sapisid: e.sapisid });
          set({ status: "signed-in", account: null, error: null });
          // Cosmetic and non-blocking — the app is fully signed in the
          // moment the line above runs, whether or not this ever resolves.
          void fetchAccount().then((account) => {
            if (account && epoch === sessionEpoch) set({ account });
          });
          // Home is the one feed whose contents differ between anonymous
          // and signed-in. Boot fetches it anonymously (the cookie jar
          // read is async, so it can't have landed first) — refetch now
          // that it's personalized. Guarded so a redundant `auth:check`
          // answer can't turn into a refetch loop.
          if (!wasSignedIn) dispatchContent({ type: "home:load" });
        } else {
          resetAuthCache();
          set({ status: "signed-out", account: null });
          if (wasSignedIn) dispatchContent({ type: "home:load" });
        }
      } else if (e.type === "auth:error") {
        sessionEpoch++;
        resetAuthCache();
        set({ status: "signed-out", account: null, error: e.message });
      }
    }
  },
}));
