import shell from "#web-shell";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "../../lib/api.ts";
import { useWorkspaces } from "../../lib/workspace.tsx";
import type { WorkspaceSwitcherProps } from "../../shell/contract.ts";
import { ShellPlace, useShellText } from "./ShellPlace.tsx";

export type { WorkspaceSwitcherProps };

/** Lists the person's workspaces when there is more than one; with one, nothing. It has no Create: `createWorkspace` and `t` are a shell's. */
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

/** What the sidebar renders as its switcher: the build's shell's (`workspaceSwitcher`), shown with one workspace too, else the public one. */
export const workspaceSwitcherSlot: { Component: ComponentType<WorkspaceSwitcherProps> } = { Component: shell.workspaceSwitcher ?? WorkspaceSwitcher };

/**
 * The slot's switcher for the tab's workspace, once it is pinned. A switch opens Home in the other
 * workspace: the current page's ids belong to this one. A shell's switcher that fails shows the
 * public one.
 */
export function WorkspaceSwitcherSlot() {
  const { workspaces, current } = useWorkspaces();
  const navigate = useNavigate();
  const t = useShellText();
  if (!current) return null;
  const { Component } = workspaceSwitcherSlot;
  const switchTo = (workspaceId: string) => void navigate({ to: "/", search: { w: workspaceId } });
  // In `current`'s organization: the page's calls carry its headers.
  const createWorkspace = async (name: string) => switchTo((await api.workspace.create({ name })).workspaceId);
  const props = { workspaces, current, switchTo, createWorkspace, t };
  if (Component === WorkspaceSwitcher) return <WorkspaceSwitcher {...props} />;
  return (
    <ShellPlace fallback={() => <WorkspaceSwitcher {...props} />}>
      <Component {...props} />
    </ShellPlace>
  );
}
