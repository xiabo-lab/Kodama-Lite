import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Hide the compositor-owned cursor for this touch-only kiosk.
 *
 * CSS can hide WebKit's cursor, but it cannot always retire a cursor that
 * GTK/winit's native window already gave the compositor during boot. This
 * call crosses that boundary. It is intentionally safe in the plain Vite
 * browser used for previews and tests.
 */
export async function hideNativeCursor(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    await getCurrentWindow().setCursorVisible(false);
  } catch {
    // The transparent CSS cursor remains the fallback. Cursor hiding must
    // never prevent the music UI from starting.
  }
}
