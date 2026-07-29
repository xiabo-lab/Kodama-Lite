import { cn } from "@/lib/utils";

/**
 * Sub-navigation as a left-hand column rather than a row of pills.
 *
 * On a 440px panel the content area is ~238px — barely one row of
 * artwork. A horizontal pill row spent ~50px of that, a fifth of
 * everything available, on navigation; stacking it beside the content
 * costs horizontal space instead, of which there are 1712 spare pixels.
 *
 * `sticky` rather than a separate scroll container: the screen still has
 * exactly one scroller (`main`), so the drag-to-scroll gesture bound to it
 * keeps working and there is no nested-scroll ambiguity under a fingertip.
 *
 * Spacing is tight on purpose. With five tabs (Local joined the four
 * account ones) the strip at `gap-1`/`py-2` came to 260px against the 238px
 * of content height the Pi's 440px panel leaves — so the last tab sat below
 * the fold and had to be scrolled to, which on a strip that IS the
 * navigation is the worst place to hide something.
 *
 * `py-1`/`gap-0.5` brings it to ~208px, leaving about 22px of headroom.
 * That margin is deliberate rather than lazy: this was measured in Chrome,
 * and the Pi renders in WebKitGTK, whose font metrics differ enough that a
 * 2px margin (which `py-1.5` gave) would be a coin flip on the real panel.
 *
 * The resulting 40px rows are just under the usual 44px touch target, which
 * is an acceptable trade HERE specifically: these are stacked neighbours,
 * so a mis-tap lands on an adjacent tab and costs one more tap to correct —
 * unlike a mis-tap on, say, a transport control.
 */
export function VerticalTabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <nav className="sticky top-0 flex w-52 shrink-0 flex-col gap-0.5 self-start">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={active === t.id ? "page" : undefined}
          onClick={() => onSelect(t.id)}
          className={cn(
            "rounded-md px-2 py-1 text-left text-base font-medium transition-colors",
            active === t.id
              ? "text-foreground underline decoration-brand decoration-2 underline-offset-8"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
