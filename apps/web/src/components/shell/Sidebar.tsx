import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  CircleHelp,
  Cpu,
  Database,
  FileText,
  House,
  Puzzle,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

/** A row that is not available yet: stays focusable so keyboard users get the tooltip too. */
function Disabled({ label, tip, Icon }: { label: string; tip: string; Icon: LucideIcon }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-disabled="true" className={`${row} cursor-default !text-muted`}>
          <Icon size={17} className="text-accent/60" aria-hidden />
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}

function Group({
  label,
  to,
  onNavigate,
  children,
}: {
  label: string;
  to?: string;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  const heading = "px-3 pb-1 text-xs font-medium text-faint";
  return (
    <div className="mt-6">
      {to ? (
        <Link to={to} onClick={onNavigate} className={`block ${heading} hover:text-muted`}>
          {label}
        </Link>
      ) : (
        <div className={heading}>{label}</div>
      )}
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
          <NavLink to="/" label="Home" Icon={House} onNavigate={onNavigate} />
          <NewPageRow className={`${row} !text-muted`} onNavigate={onNavigate} />
          {pages.data
            ?.filter((p) => p.kind === "page")
            .map((p) => (
              <NavLink key={p.id} to={`/p/${p.id}`} label={p.title} Icon={FileText} onNavigate={onNavigate} />
            ))}
        </div>
        <Group label="Settings" onNavigate={onNavigate}>
          {settings.map((s) => (
            <NavLink key={s.to} {...s} onNavigate={onNavigate} />
          ))}
        </Group>
        <Group label="Help" to="/help" onNavigate={onNavigate}>
          <Disabled label="Start the guided tour" tip="The tour arrives soon" Icon={CircleHelp} />
        </Group>
      </nav>

      <div className="border-t border-line pt-3">
        <UserMenu user={user} />
      </div>
    </div>
  );
}
