import { dispatch } from "@/bus/bus";

/**
 * Print a view-plane diagnostic somewhere it can actually be read.
 *
 * On the Pi the app is a full-screen appliance on a 440px panel with no
 * devtools, no address bar and no console. `console.log` from the webview
 * reaches **nothing** — verified by filtering a whole boot out of
 * `journalctl _SYSTEMD_USER_UNIT=kodama-lite.service`, which contains the
 * data plane's output and not one line of the view plane's. So anything
 * needed to reconstruct a boot afterwards has to cross the bus.
 *
 * Both halves are on purpose: the `console.log` is what makes this useful
 * in `npm run dev` and in the browser harness, and the dispatch is what
 * makes it useful in the car.
 *
 * Keep call sites rare and about lifecycle. Anything on the playback path
 * would be several lines a second in the system journal for the length of
 * a drive.
 */
export function logLine(scope: string, message: string): void {
  console.log(`[${scope}] ${message}`);
  dispatch({ type: "log:line", scope, message });
}
