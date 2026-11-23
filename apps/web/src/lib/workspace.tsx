import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { retainSearchParams, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { z } from "zod";
import { setWorkspace } from "./api.ts";

/** A workspace the person can open, as `workspace.mine` lists it. */
export type Workspace = { organizationId: string; workspaceId: string; name: string; role: "owner" | "manager" | "member" };

/** The root route's `?w`, the tab's workspace, kept by every navigation that doesn't name another. */
export const workspaceSearch = {
  validateSearch: z.object({ w: z.string().max(100).optional() }),
  search: { middlewares: [retainSearchParams<{ w?: string }>(["w"])] },
};

const KEY = "dispand-workspace";

/** The workspace this browser last worked in; none where storage is unavailable. */
export function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(workspaceId: string) {
  try {
    localStorage.setItem(KEY, workspaceId);
  } catch {
    // Private mode or blocked storage: the next tab without `?w` opens the first workspace.
  }
}

/** The tab's workspace: `?w`, then the only entry, then the remembered preference, then the first. */
export function resolveWorkspace(w: string | undefined, workspaces: Workspace[], preferred: string | null): Workspace | undefined {
  const named = (id: string | null | undefined) => workspaces.find((x) => x.workspaceId === id);
  return named(w) ?? (workspaces.length === 1 ? workspaces[0] : undefined) ?? named(preferred) ?? workspaces[0];
}

const Current = createContext<{ workspaces: Workspace[]; current: Workspace | undefined }>({ workspaces: [], current: undefined });

/** The person's workspaces and the one this tab works in. */
export const useWorkspaces = () => useContext(Current);

/**
 * Renders the page in the tab's workspace. With several workspaces the tab is pinned in `?w` first
 * (the remembered choice lives in the browser, so the server renders nothing until then), and
 * another tab's switch never moves this one. Each workspace gets its own query cache, remounted on
 * every change of `?w` (Back included), so no answer from one shows under another.
 */
export function WorkspaceScope({ workspaces, w, children }: { workspaces: Workspace[]; w: string | undefined; children: ReactNode }) {
  const navigate = useNavigate();
  const pinned = workspaces.length <= 1 || workspaces.some((x) => x.workspaceId === w);
  const current = pinned ? resolveWorkspace(w, workspaces, null) : undefined;
  // While rendering, so the subtree's first requests already carry it.
  setWorkspace(current ?? null);
  useEffect(() => {
    if (pinned) return;
    const to = resolveWorkspace(w, workspaces, remembered())!.workspaceId;
    void navigate({ to: ".", search: (prev) => ({ ...prev, w: to }), replace: true });
  }, [pinned, w, workspaces, navigate]);
  const currentId = current?.workspaceId;
  useEffect(() => {
    if (currentId) remember(currentId);
  }, [currentId]);
  if (!pinned) return null;
  return (
    <Current.Provider value={{ workspaces, current }}>
      <Queries key={currentId ?? ""}>{children}</Queries>
    </Current.Provider>
  );
}

function Queries({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
