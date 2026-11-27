// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatPanel } from "../components/widgets/ChatPanel.tsx";
import { ChatSessionsProvider } from "./chat-sessions.tsx";

// The chunk a deploy removed.
vi.mock("../components/widgets/ChatSessionHost.tsx", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a chat whose code a deploy removed reloads the page", async () => {
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  render(
    <ChatSessionsProvider>
      <ChatPanel surfaceKey="test" runId={null} onRunStarted={() => {}} />
    </ChatSessionsProvider>,
  );
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});
