import type { Route } from "@/store/appStore";

/**
 * Whether the screen saver may come up at all. Home only — and not while
 * something is open over Home that the user is still looking at: the
 * karaoke stage is an overlay, not a route, so `route` alone would still
 * say "home" underneath it, and the queue panel stays open on its own
 * without a touch.
 */
export function screenSaverEligible(route: Route, karaokeOpen: boolean, queueOpen: boolean): boolean {
  return route.kind === "home" && !karaokeOpen && !queueOpen;
}

/**
 * Milliseconds left before the saver is due, given the last activity. Times
 * are `performance.now()` values — monotonic, unlike `Date.now()`. The Pi
 * has no RTC and NTP steps its wall clock by tens of minutes after boot, a
 * jump that would fire (or postpone) a wall-clock deadline at random.
 */
export function idleRemainingMs(lastActivity: number, now: number, delayMs: number): number {
  return Math.max(0, delayMs - (now - lastActivity));
}
