import { Link } from "@tanstack/react-router";

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
