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
    <nav className="sticky top-0 flex w-52 shrink-0 flex-col gap-1 self-start">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={active === t.id ? "page" : undefined}
          onClick={() => onSelect(t.id)}
          className={cn(
            "rounded-md px-2 py-2 text-left text-base font-medium transition-colors",
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
