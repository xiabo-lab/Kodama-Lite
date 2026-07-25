//! Accounts subsystem. Owns the one thing about signing in that genuinely
//! has to be Rust: reading the webview's cookie jar.
//!
//! YouTube Music's InnerTube API authenticates with the ordinary Google web
//! session — `Cookie: SID=…; HSID=…; SSID=…; APISID=…; SAPISID=…` plus an
//! `Authorization: SAPISIDHASH <ts>_<sha1(ts SAPISID origin)>` digest. The
//! cookies that matter (`SID`, `HSID`, `SSID`, the `__Secure-*` variants)
//! are HttpOnly, so `document.cookie` inside a login page cannot see them —
//! only the runtime's own cookie store can, which is what
//! `Webview::cookies_for_url` exposes. That single call is the entire
//! reason this subsystem exists on this side of the bus.
//!
//! The flow is: open a plain webview window on Google's sign-in page, then
//! poll the shared cookie jar until a real session appears. Polling rather
//! than hooking navigation is deliberate — Google's login is a multi-step
//! SPA (password, 2FA, consent, interstitials) and the cookies land at a
//! point that isn't reliably tied to any one navigation. A 750ms poll costs
//! nothing and doesn't care what route the login took.
//!
//! NOTHING IS PERSISTED HERE. The webview's own cookie store is the single
//! source of truth; `check()` re-reads it on every boot. That keeps a live
//! Google master session out of localStorage and off disk in any form this
//! app wrote itself.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::bus::emit;
use crate::protocol::AppEvent;

const LOGIN_WINDOW_LABEL: &str = "auth";

/// The origin every cookie read/write below is scoped to — the only one
/// InnerTube requests are sent to.
const YTM_ORIGIN: &str = "https://music.youtube.com/";

/// Google's sign-in entry point, told to hand off to YouTube Music when
/// it's done. Landing back on music.youtube.com is what makes the session
/// cookies show up for `YTM_ORIGIN`.
const LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";

/// Origins whose cookies a sign-out clears. Signing out of YouTube Music
/// alone would leave the Google session intact and the next sign-in would
/// silently reuse it, which is not what "sign out" means to a user.
const SIGN_OUT_ORIGINS: [&str; 4] = [
    "https://music.youtube.com/",
    "https://www.youtube.com/",
    "https://accounts.google.com/",
    "https://www.google.com/",
];

/// How long the sign-in window waits for a session before giving up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(600);
const POLL_INTERVAL: Duration = Duration::from_millis(750);

/// The two values the view plane needs: the whole `Cookie:` header, and the
/// SAPISID the per-request `Authorization` digest is derived from.
struct Session {
    cookie: String,
    sapisid: String,
}

/// Read the runtime cookie store for `music.youtube.com` and decide whether
/// what's there is a real signed-in session.
///
/// The read goes through the *main* window rather than the login one: the
/// cookie store is runtime-wide, not per-webview, so the main window sees
/// cookies the login window set — and it's still there to be asked long
/// after the login window has closed, which is what makes `check()` on a
/// later boot work.
fn read_session(app: &AppHandle) -> Option<Session> {
    let window = app.get_webview_window("main")?;
    let cookies = YTM_ORIGIN
        .parse()
        .ok()
        .and_then(|url| window.cookies_for_url(url).ok())?;

    let mut pairs: Vec<String> = Vec::with_capacity(cookies.len());
    let mut sapisid: Option<String> = None;
    let mut has_sid = false;

    for cookie in cookies {
        let name = cookie.name();
        let value = cookie.value();
        // `SAPISID` is the first-party name; `__Secure-3PAPISID` is the
        // third-party-context twin Google sets alongside it. Either works
        // for the digest, but prefer the plain one when both are present.
        match name {
            "SAPISID" => sapisid = Some(value.to_string()),
            "__Secure-3PAPISID" if sapisid.is_none() => sapisid = Some(value.to_string()),
            "SID" | "__Secure-3PSID" | "__Secure-1PSID" => has_sid = true,
            _ => {}
        }
        pairs.push(format!("{name}={value}"));
    }

    // A signed-OUT visitor still has cookies here (VISITOR_INFO1_LIVE,
    // PREF, YSC…), so a non-empty jar proves nothing. Requiring both an
    // authority cookie and a session ID is what separates "someone visited"
    // from "someone is signed in".
    let sapisid = sapisid?;
    if !has_sid {
        return None;
    }

    Some(Session {
        cookie: pairs.join("; "),
        sapisid,
    })
}

fn emit_session(app: &AppHandle, session: Option<Session>) {
    let event = match session {
        Some(s) => AppEvent::AuthState {
            signed_in: true,
            cookie: Some(s.cookie),
            sapisid: Some(s.sapisid),
        },
        None => AppEvent::AuthState {
            signed_in: false,
            cookie: None,
            sapisid: None,
        },
    };
    emit(app, event);
}

/// Report the session already in the cookie jar, if any. Cheap enough to
/// fire unconditionally on boot — it's a local read, no network.
pub fn check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let session = read_session(&app);
        emit_session(&app, session);
    });
}

/// Open the sign-in window and watch for the session it produces.
pub fn sign_in(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Already open (double-tap on the Pi's touch panel is easy to do) —
        // raise it instead of stacking a second login window.
        if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
            let _ = existing.set_focus();
            return;
        }

        let url = match LOGIN_URL.parse() {
            Ok(url) => url,
            Err(err) => {
                emit(
                    &app,
                    AppEvent::AuthError {
                        message: format!("bad sign-in URL: {err}"),
                    },
                );
                return;
            }
        };

        // Size to the actual panel. The Pi's display is 1920x440, so the
        // 1024x700 that would be a sensible default on a desktop would open
        // taller than the screen with its own close button off-screen.
        // Asked via the main window rather than the app handle so it's the
        // monitor this app is actually on, not merely the primary one.
        let (width, height) = app
            .get_webview_window("main")
            .and_then(|window| window.current_monitor().ok().flatten())
            .map(|monitor| {
                let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
                (size.width, size.height)
            })
            .unwrap_or((1024.0, 700.0));

        let built = WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
            .title("Sign in to YouTube Music")
            .inner_size(width, height)
            .center()
            .focused(true)
            .build();

        if let Err(err) = built {
            emit(
                &app,
                AppEvent::AuthError {
                    message: format!("couldn't open the sign-in window: {err}"),
                },
            );
            return;
        }

        let deadline = Instant::now() + SIGN_IN_TIMEOUT;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            if let Some(session) = read_session(&app) {
                close_login_window(&app);
                emit_session(&app, Some(session));
                return;
            }

            // The user closed the window without finishing. Report
            // signed-out so the UI leaves its pending state instead of
            // spinning until the timeout.
            if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
                emit_session(&app, None);
                return;
            }

            if Instant::now() >= deadline {
                close_login_window(&app);
                emit(
                    &app,
                    AppEvent::AuthError {
                        message: "Sign-in timed out.".into(),
                    },
                );
                return;
            }
        }
    });
}

/// Clear the session. Deletes every cookie the runtime holds for the Google
/// and YouTube origins, then reports signed-out.
pub fn sign_out(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(window) = app.get_webview_window("main") {
            for origin in SIGN_OUT_ORIGINS {
                let Ok(url) = origin.parse() else { continue };
                let cookies = window.cookies_for_url(url).unwrap_or_default();
                for cookie in cookies {
                    let _ = window.delete_cookie(cookie);
                }
            }
        }
        // Reported unconditionally: even if a cookie deletion failed, the
        // view plane has already dropped its copy of the credentials, so
        // "signed out" is the truthful state of the app either way.
        emit_session(&app, None);
    });
}

fn close_login_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.close();
    }
}
