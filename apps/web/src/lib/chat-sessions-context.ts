import { createContext, useContext } from "react";
import type { ChatSessions } from "./chat-sessions.tsx";

// Apart from `chat-sessions.tsx`: its provider renders the hosts (`ChatSessionHost.tsx`) that read this.
export const ChatSessionsContext = createContext<ChatSessions | null>(null);

export function useChatSessions() {
  const sessions = useContext(ChatSessionsContext);
  if (!sessions) throw new Error("ChatSessionsProvider is required");
  return sessions;
}
