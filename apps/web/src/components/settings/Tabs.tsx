import { Link } from "@tanstack/react-router";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { ReactNode } from "react";

const tab = "-mb-px border-b-2 px-1 pb-2.5 text-[14px] transition";

/** Route-based tabs at the top of a settings page: each tab is a link, the current one is marked. */
export function Tabs({ tabs }: { tabs: { to: string; label: string }[] }) {
  return (
    <nav aria-label="Tabs" className="mb-6 flex gap-5 border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          activeOptions={{ exact: true }}
          className={`${tab} border-transparent text-muted hover:text-fg`}
          activeProps={{ className: `${tab} border-accent font-medium text-fg`, "aria-current": "page" }}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Tabs of one page that switch in place: the selected one is marked, `onSelect` gets its key. */
export function StateTabs<K extends string>({ label, tabs, selected, onSelect, children }: { label: string; tabs: readonly (readonly [K, string])[]; selected: K; onSelect: (key: K) => void; children: ReactNode }) {
  return (
    <TabsPrimitive.Root value={selected} onValueChange={(key) => onSelect(key as K)}>
      <TabsPrimitive.List aria-label={label} className="mb-6 flex gap-5 border-b border-line">
        {tabs.map(([key, text]) => (
          <TabsPrimitive.Trigger key={key} value={key} type="button" className={selected === key ? `${tab} border-accent font-medium text-fg` : `${tab} border-transparent text-muted hover:text-fg`}>
            {text}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  );
}
