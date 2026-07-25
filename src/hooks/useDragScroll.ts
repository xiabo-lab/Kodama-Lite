import { useEffect, type RefObject } from "react";

/** Vertical travel (px) before a press becomes a scroll. Below this a
 *  press is still a tap, so track rows and buttons keep working. */
const THRESHOLD = 8;
/** Below this speed (px/ms) at lift-off, don't glide at all. */
const FLING_MIN = 0.12;
/** Per-frame velocity decay for the glide, at 60fps. */
const FLING_DECAY = 0.94;
/** Stop the glide once it's crawling. */
const FLING_STOP = 0.02;

/** Presses that start on these never scroll — dragging a slider is
 *  scrubbing, and dragging in a text field is selecting. */
const NO_DRAG_SELECTOR = "input, textarea, [contenteditable], [role=slider]";

/**
 * Drag-to-scroll for `ref`, with a short inertial glide after a flick.
 * Ported from YTMLite's `hooks/use-drag-scroll.ts`, which was written
 * against this exact hardware.
 *
 * Why this exists: on the Pi's touch panel a finger doesn't pan the page
 * at all — it starts a text selection instead. YTMLite's first attempt at
 * fixing it listened for `touchstart`/`touchmove` and did nothing, which
 * is the tell: the app's WebKitGTK webview never dispatches DOM touch
 * events for this panel, so both the browser's own panning and any
 * touch-event handler are dead ends. It reports presses as *pointer*
 * events instead, which is what this listens to — pointer events are the
 * one input model that covers touch, pen and mouse alike, so the gesture
 * works regardless of how the webview classifies the panel.
 *
 * This is also why the app does one-finger drag rather than two-finger
 * scroll: a webview that doesn't report touch at all can't report a
 * second finger either.
 *
 * Axis-locked to vertical: a mostly-horizontal drag is left alone so the
 * shelf carousels keep their own horizontal panning. Once a drag passes
 * the threshold the pointer is captured and the click that would
 * otherwise land at lift-off is swallowed, so flicking the list past a
 * track doesn't start playing it.
 *
 * Note: this assumes the platform does NOT also pan natively — true for
 * the Pi, and the reason the feature is needed. On a platform that does
 * (a desktop browser with a touchscreen), the two would add up and
 * scroll twice as fast.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let dragging = false;
    let raf = 0;

    const stopGlide = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const glide = () => {
      raf = 0;
      if (Math.abs(velocity) < FLING_STOP) return;
      // 16ms ≈ one frame; velocity is px/ms.
      el.scrollTop += velocity * 16;
      velocity *= FLING_DECAY;
      raf = requestAnimationFrame(glide);
    };

    const reset = () => {
      pointerId = null;
      dragging = false;
      velocity = 0;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      stopGlide();
      const target = e.target as HTMLElement | null;
      if (target?.closest(NO_DRAG_SELECTOR)) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      lastY = e.clientY;
      lastT = e.timeStamp;
      dragging = false;
      velocity = 0;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;

      if (!dragging) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        // Horizontal wins: leave it to the carousels.
        if (dx > dy) {
          pointerId = null;
          return;
        }
        if (dy <= THRESHOLD) return;
        dragging = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone — the move handler below still works */
        }
      }

      const dy = lastY - e.clientY;
      const dt = e.timeStamp - lastT;
      lastY = e.clientY;
      lastT = e.timeStamp;
      if (dt > 0) velocity = dy / dt;
      el.scrollTop += dy;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const wasDragging = dragging;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      reset();
      if (!wasDragging) return;

      // Swallow the click that would fire on whatever the finger lifted
      // over — otherwise flicking the list plays a track.
      const suppress = (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      el.addEventListener("click", suppress, { capture: true, once: true });
      setTimeout(() => {
        el.removeEventListener("click", suppress, { capture: true });
      }, 0);

      if (Math.abs(velocity) >= FLING_MIN) {
        stopGlide();
        raf = requestAnimationFrame(glide);
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      stopGlide();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [ref]);
}
