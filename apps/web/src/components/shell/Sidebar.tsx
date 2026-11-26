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
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { orpc } from "../../lib/api.ts";
import type { Language } from "../../lib/i18n.ts";
import { useWorkspaces } from "../../lib/workspace.tsx";
import { NewPageRow } from "./NewPageRow.tsx";
import { NotificationsBell } from "./NotificationsBell.tsx";
import { UserMenu } from "./UserMenu.tsx";
import { WorkspaceSwitcherSlot } from "./WorkspaceSwitcher.tsx";

const settings = [
  { to: "/settings/harnesses", label: "nav.harnesses", Icon: Cpu },
  { to: "/settings/agents", label: "nav.agents", Icon: Bot },
  { to: "/settings/skills", label: "nav.skills", Icon: Sparkles },
  { to: "/settings/tools", label: "nav.tools", Icon: Wrench },
  { to: "/settings/plugins", label: "nav.plugins", Icon: Puzzle },
  { to: "/settings/data", label: "nav.data", Icon: Database },
  { to: "/settings/memory", label: "nav.memory", Icon: Brain },
  { to: "/settings/workflows", label: "nav.workflows", Icon: Workflow },
] as const;

const row =
  "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[14px] text-fg transition hover:bg-hover";

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

export function Sidebar({ user, onNavigate }: { user: { name: string; email: string; language: Language | null }; onNavigate: () => void }) {
  const { t } = useTranslation(["shell", "messages"]);
  const managed = useQuery(orpc.workspace.managed.queryOptions({ gcTime: 0 }));
  const { current } = useWorkspaces();
  const pages = useQuery(orpc.pages.list.queryOptions());
  return (
    <div className="flex h-full flex-col px-3 pb-3 pt-4">
      <div className="spectrum-header relative mb-2 flex items-center justify-between px-3 pb-3">
        <span className="text-xl font-semibold tracking-[-0.03em] lowercase">Dispand</span>
        <NotificationsBell onNavigate={onNavigate} />
      </div>
      <WorkspaceSwitcherSlot />

      <nav aria-label={t("main")} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-px">
          <NavLink to="/assistant" label={t("messages:agent.assistant.name")} Icon={MessageCircle} onNavigate={onNavigate} />
          <NavLink to="/" label={t("nav.home")} Icon={House} onNavigate={onNavigate} />
          <NavLink to="/audit" label={t("nav.audit")} Icon={ScrollText} onNavigate={onNavigate} />
          <NewPageRow className={`${row} !text-muted`} onNavigate={onNavigate} />
          {pages.data
            ?.filter((p) => p.kind === "page")
            .map((p) => (
              <NavLink key={p.id} to={`/p/${p.id}`} label={p.title} Icon={FileText} onNavigate={onNavigate} />
            ))}
        </div>
        <Group label={t("nav.settings")}>
          {managed.data?.some((m) => m.workspaceId === current?.workspaceId) && <NavLink to="/settings/people" label={t("nav.people")} Icon={Users} onNavigate={onNavigate} />}
          {settings.map((s) => (
            <NavLink key={s.to} to={s.to} label={t(s.label)} Icon={s.Icon} onNavigate={onNavigate} />
          ))}
        </Group>
        <div className="mt-6">
          <NavLink to="/help" label={t("nav.help")} Icon={CircleHelp} onNavigate={onNavigate} />
        </div>
      </nav>

      <div className="border-t border-line pt-3">
        <UserMenu user={user} workspace={current} />
      </div>
    </div>
  );
}
