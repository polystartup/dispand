import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChatSession } from "../../lib/chat-sessions.tsx";
import { useChatSessions } from "../../lib/chat-sessions-context.ts";

// What a page showing a chat imports: no part of the chat stack, which `ChatSessionHost.tsx` brings once a session needs it.

export type ChatPanelOptions = {
  /** The workflow whose Chat field this is; absent for an agent's chat trigger, whose Job has its own definition. */
  workflowId?: string;
  /** Starts the conversation's run (default: a run of `workflowId`). */
  start?: (skillId?: string) => Promise<{ runId: string }>;
  /** The conversation shown; null: a new one starts with the first message. */
  runId: string | null;
  onRunStarted: (runId: string) => void;
  /** Absent: no new conversation can start (a disabled trigger's). */
  onNewConversation?: () => void;
  /** What an empty conversation invites the owner to say (default: a plain hello). */
  welcome?: string;
  composerTools?: ReactNode;
  assistantAgentId?: string;
};

export type ChatSessionView = ReactNode;

/** Visible surfaces attach to session-owned runtimes without copying composer state. */
export function ChatPanel({ surfaceKey, ...options }: ChatPanelOptions & { surfaceKey: string }) {
  const sessions = useChatSessions();
  const generation = useSyncExternalStore(
    sessions.subscribe,
    () => sessions.generation(surfaceKey),
    () => 0,
  );
  const [session, setSession] = useState<ChatSession | null>(null);
  const { workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId } = options;
  useLayoutEffect(() => {
    const next = sessions.get(surfaceKey, { workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId });
    next.setActive(true);
    next.update({ workflowId, start, runId: runId ?? next.options.runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId });
    // The surface attaches to its session in the store, and detaches in the cleanup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(next);
    return () => {
      sessions.deactivate(next);
    };
  }, [sessions, surfaceKey, generation, workflowId, start, runId, onRunStarted, onNewConversation, welcome, composerTools, assistantAgentId]);
  return session ? <SessionView key={session.id} session={session} /> : null;
}

function SessionView({ session }: { session: ChatSession }) {
  return useSyncExternalStore(session.subscribe, session.getView, session.getView);
}
