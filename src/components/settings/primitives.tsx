import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the settings screen, ported from YTMLite's
 * `components/settings/primitives.tsx` — the same flat-list language:
 * no card chrome, rows separated by hairline dividers only.
 *
 * Hit targets are taller than YTMLite's (`py-4` → `py-3.5` plus a 44px
 * minimum on every control) because this build is only ever driven by a
 * fingertip.
 */

/** Cluster of related rows. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-hairline">{children}</div>
  );
}

export function SettingRow({
  icon: Icon,
  title,
  description,
  control,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-[18px] text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] font-medium leading-none">{title}</span>
        {description ? (
          <span className="text-[13px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      {control}
    </div>
  );
}

/** Section heading inside a tab pane. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * Two-or-more-way pick control. A plain segmented button group rather
 * than a Radix primitive — this project still has no `@radix-ui/*`, and
 * the queue panel / menus are built the same way.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-9 rounded-md px-4 text-sm font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * On/off switch. Sized at 44px wide / 28px tall with a large invisible
 * padding box so the tap target clears the ~44px finger minimum without
 * the control itself looking oversized.
 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors",
        checked ? "bg-brand" : "bg-muted-foreground/40",
      )}
    >
      <span
        className={cn(
          "size-6 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
