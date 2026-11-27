import { lazy, Suspense, useCallback, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ChatPanelOptions, ChatSessionView } from "../components/widgets/ChatPanel.tsx";
import { ChatSessionsContext, useChatSessions } from "./chat-sessions-context.ts";

// The chat stack (assistant-ui, markdown) loads with the first conversation, not with every page:
// a host exists only once a surface has asked for one.
const ChatSessionHost = lazy(() => import("../components/widgets/ChatPanel.tsx").then((m) => ({ default: m.ChatSessionHost })));

/** A mounted stock runtime owns the draft; this record only connects it to its visible surface. */
export class ChatSession {
  readonly id = crypto.randomUUID();
  view: ChatSessionView | null = null;
  active = false;
  pending = 0;
  private listeners = new Set<() => void>();
  constructor(
    readonly surfaceKey: string,
    public options: ChatPanelOptions,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getOptions = () => this.options;
  getView = () => this.view;
  getActive = () => this.active;
  setActive(active: boolean) {
    this.active = active;
    this.notify();
  }
  notify = () => {
    for (const listener of this.listeners) listener();
  };
  update(options: ChatPanelOptions) {
    this.options = options;
    this.notify();
  }
  publish(view: ChatSessionView) {
    this.view = view;
    this.notify();
  }
}

export class ChatSessions {
  alive = true;
  private conversations = new Map<string, ChatSession>();
  private generations = new Map<string, number>();
  private selections = new Map<string, string | null | undefined>();
  private listeners = new Set<() => void>();
  private hosts: ChatSession[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getHosts = () => this.hosts;
  private notify() {
    for (const listener of this.listeners) listener();
  }
  private collect(session: ChatSession) {
    if (session.active || session.pending > 0 || [...this.conversations.values()].includes(session)) return;
    this.hosts = this.hosts.filter((host) => host !== session);
    this.notify();
  }
  deactivate(session: ChatSession) {
    session.setActive(false);
    this.collect(session);
  }
  begin(session: ChatSession) {
    session.pending++;
  }
  settle(session: ChatSession) {
    session.pending--;
    this.collect(session);
  }
  generation(surfaceKey: string) {
    return this.generations.get(surfaceKey) ?? 0;
  }
  selection(surfaceKey: string) {
    return this.selections.get(surfaceKey);
  }
  select(surfaceKey: string, runId: string | null | undefined) {
    this.selections.set(surfaceKey, runId);
    this.notify();
  }
  get(surfaceKey: string, options: ChatPanelOptions) {
    const key = JSON.stringify([surfaceKey, options.runId]);
    let session = this.conversations.get(key);
    if (!session) {
      session = new ChatSession(surfaceKey, options);
      this.conversations.set(key, session);
      this.hosts = [...this.hosts, session];
      this.notify();
    }
    return session;
  }
  started(session: ChatSession, runId: string) {
    const freshKey = JSON.stringify([session.surfaceKey, null]);
    // Keep the unsent alias until explicit New: route navigation may still render its old null id.
    const wasFresh = this.conversations.get(freshKey) === session;
    this.conversations.set(JSON.stringify([session.surfaceKey, runId]), session);
    session.update({ ...session.options, runId });
    if (wasFresh && this.selection(session.surfaceKey) === null) this.select(session.surfaceKey, runId);
  }
  newConversation(surfaceKey: string) {
    const key = JSON.stringify([surfaceKey, null]);
    const previous = this.conversations.get(key);
    this.conversations.delete(key);
    if (previous) this.collect(previous);
    this.generations.set(surfaceKey, this.generation(surfaceKey) + 1);
    this.select(surfaceKey, null);
  }
}

export { useChatSessions };

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions] = useState(() => new ChatSessions());
  // `sessions` is the store, a mutable object kept in state for its identity. Renders read it only
  // through useSyncExternalStore; `alive` is read by a send in flight (ChatPanel), never in a render.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    sessions.alive = true;
    return () => {
      sessions.alive = false;
    };
  }, [sessions]);
  const hosts = useSyncExternalStore(sessions.subscribe, sessions.getHosts, sessions.getHosts);
  return (
    <ChatSessionsContext.Provider value={sessions}>
      {hosts.map((session) => (
        <Suspense key={session.id} fallback={null}>
          <ChatSessionHost session={session} />
        </Suspense>
      ))}
      {children}
    </ChatSessionsContext.Provider>
  );
}

export function useChatSelection(surfaceKey: string): [string | null | undefined, (runId: string | null | undefined) => void] {
  const sessions = useChatSessions();
  const selected = useSyncExternalStore(
    sessions.subscribe,
    () => sessions.selection(surfaceKey),
    () => undefined,
  );
  const select = useCallback((runId: string | null | undefined) => sessions.select(surfaceKey, runId), [sessions, surfaceKey]);
  return [selected, select];
}
