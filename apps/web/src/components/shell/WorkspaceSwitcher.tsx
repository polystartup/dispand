import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useWorkspaces, type Workspace } from "../../lib/workspace.tsx";

export type WorkspaceSwitcherProps = { workspaces: Workspace[]; current: Workspace; switchTo: (workspaceId: string) => void };

/** Lists the person's workspaces when there is more than one; with one, nothing. */
export function WorkspaceSwitcher({ workspaces, current, switchTo }: WorkspaceSwitcherProps) {
  const { t } = useTranslation("shell");
  if (workspaces.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("workspace.switch", { name: current.name })}
        className="mb-2 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[14px] font-medium transition hover:bg-hover data-[state=open]:bg-hover"
      >
        <span className="min-w-0 flex-1 truncate">{current.name}</span>
        <ChevronsUpDown size={14} className="text-faint" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 rounded-xl border-0 p-2 shadow-pop">
        <DropdownMenuRadioGroup value={current.workspaceId} onValueChange={switchTo}>
          {workspaces.map((x) => (
            <DropdownMenuRadioItem key={x.workspaceId} value={x.workspaceId}>
              <span className="truncate">{x.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the sidebar renders as its switcher: another shell sets `Component` to its own, with its own actions and shown with one workspace too. */
export const workspaceSwitcherSlot: { Component: ComponentType<WorkspaceSwitcherProps> } = { Component: WorkspaceSwitcher };

/** The slot's switcher for the tab's workspace. A switch opens Home in the other workspace: the current page's ids belong to this one. */
export function WorkspaceSwitcherSlot() {
  const { workspaces, current } = useWorkspaces();
  const navigate = useNavigate();
  if (!current) return null;
  const { Component } = workspaceSwitcherSlot;
  return <Component workspaces={workspaces} current={current} switchTo={(workspaceId) => void navigate({ to: "/", search: { w: workspaceId } })} />;
}
