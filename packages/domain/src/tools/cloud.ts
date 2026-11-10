import type { ToolCaller } from "../cloud/runner.ts";
import type { Db } from "../db/client.ts";
import { sessionTooling } from "../engine/tooling.ts";
import type { InstalledTools } from "./executor.ts";

const PREFIX = "tool:";
const GONE = { text: "This tool is not available.", isError: true };

/**
 * An agent's HTTP tools for its cloud sessions: each action of each tool the session's agent
 * gives it (`sessionTooling`) is one tool for the model. A call runs on the server through
 * `InstalledTools`, where the tool's sealed headers are opened for that call only; the cloud
 * runner asks the owner before each one, but for the actions the agent lets run unasked. What the session may call is read again at call
 * time: a tool taken back from the agent, or an action it no longer lists, isn't called.
 */
export function installedToolCaller(db: Db, installed: InstalledTools): ToolCaller {
  return {
    async specs(sessionId) {
      const { httpTools } = await sessionTooling(db, sessionId);
      return httpTools.flatMap((tool) =>
        tool.actions.map((action) => ({
          key: `${PREFIX}${tool.id}:${action.name}`,
          label: `${tool.name} ${action.name}`,
          spec: { name: "", description: action.description, inputSchema: action.inputSchema },
          ...(tool.unasked.includes(action.name) ? { ask: false as const } : {}),
        })),
      );
    },
    async call(sessionId, key, args, signal) {
      if (!key.startsWith(PREFIX)) return GONE;
      const [toolId, ...rest] = key.slice(PREFIX.length).split(":");
      const actionName = rest.join(":");
      const tool = (await sessionTooling(db, sessionId)).httpTools.find((t) => t.id === toolId);
      if (!tool?.actions.some((a) => a.name === actionName)) return GONE;
      if (typeof args !== "object" || args === null || Array.isArray(args)) return { text: "The arguments must be an object.", isError: true };
      const called = await installed.call(tool, actionName, args as Record<string, unknown>, signal);
      return called.ok ? { text: called.result.text, isError: called.result.isError } : { text: called.error, isError: true };
    },
  };
}
