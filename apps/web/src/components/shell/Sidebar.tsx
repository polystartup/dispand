import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  Brain,
  CircleHelp,
  Cpu,
  Database,
  FileText,
  House,
  MessageCircle,
  ScrollText,
  Puzzle,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { orpc } from "../../lib/api.ts";
import { NewPageRow } from "./NewPageRow.tsx";
import { NotificationsBell } from "./NotificationsBell.tsx";
import { UserMenu } from "./UserMenu.tsx";

const settings: { to: string; label: string; Icon: LucideIcon }[] = [
  { to: "/settings/harnesses", label: "Harnesses", Icon: Cpu },
  { to: "/settings/agents", label: "Agents", Icon: Bot },
  { to: "/settings/skills", label: "Skills", Icon: Sparkles },
  { to: "/settings/tools", label: "Tools", Icon: Wrench },
  { to: "/settings/plugins", label: "Plugins", Icon: Puzzle },
  { to: "/settings/data", label: "Data", Icon: Database },
  { to: "/settings/memory", label: "Memory", Icon: Brain },
  { to: "/settings/workflows", label: "Workflows", Icon: Workflow },
];

const row =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[14px] text-fg transition hover:bg-hover";

function NavLink({ to, label, Icon, onNavigate }: { to: string; label: string; Icon: LucideIcon; onNavigate: () => void }) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={row}
      activeProps={{ className: `${row} bg-active font-medium`, "aria-current": "page" }}
    >
      <Icon size={17} className="text-accent" aria-hidden />
      {label}
    </Link>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <div className="px-3 pb-1 text-xs font-medium text-faint">{label}</div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

export function Sidebar({ user, onNavigate }: { user: { name: string; email: string }; onNavigate: () => void }) {
  const pages = useQuery(orpc.pages.list.queryOptions());
  return (
    <div className="flex h-full flex-col px-3 pb-3 pt-4">
      <div className="flex items-center justify-between px-3 pb-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-foreground" aria-hidden>
            <Workflow size={16} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Dispand</span>
        </div>
        <NotificationsBell onNavigate={onNavigate} />
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-px">
          <NavLink to="/assistant" label="Assistant" Icon={MessageCircle} onNavigate={onNavigate} />
          <NavLink to="/" label="Home" Icon={House} onNavigate={onNavigate} />
          <NavLink to="/audit" label="Audit" Icon={ScrollText} onNavigate={onNavigate} />
          <NewPageRow className={`${row} !text-muted`} onNavigate={onNavigate} />
          {pages.data
            ?.filter((p) => p.kind === "page")
            .map((p) => (
              <NavLink key={p.id} to={`/p/${p.id}`} label={p.title} Icon={FileText} onNavigate={onNavigate} />
            ))}
        </div>
        <Group label="Settings">
          {settings.map((s) => (
            <NavLink key={s.to} {...s} onNavigate={onNavigate} />
          ))}
        </Group>
        <div className="mt-6">
          <NavLink to="/help" label="Help" Icon={CircleHelp} onNavigate={onNavigate} />
        </div>
      </nav>

      <div className="border-t border-line pt-3">
        <UserMenu user={user} />
      </div>
    </div>
  );
}
