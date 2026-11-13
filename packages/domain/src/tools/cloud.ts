import { recordToolCall } from "../audit/tool-call.ts";
import type { ToolCaller } from "../cloud/runner.ts";
import { keepJobFiles } from "../data/files.ts";
import type { Db } from "../db/client.ts";
import { logError } from "../log.ts";
import { sessionTooling } from "../engine/tooling.ts";
import type { InstalledTools } from "./executor.ts";

const PREFIX = "tool:";
const toolKey = (toolId: string, action: string) => `${PREFIX}${toolId}:${action}`;
const ofKey = (key: string) => {
  const [toolId, ...rest] = key.slice(PREFIX.length).split(":");
  return { toolId: toolId!, action: rest.join(":") };
};
const GONE = { text: "This tool is not available.", isError: true };

/**
 * An agent's HTTP tools for its cloud sessions: each action of each tool the session's agent
 * gives it (`sessionTooling`) is one tool for the model. A call runs on the server through
 * `InstalledTools`, where the tool's sealed headers are opened for that call only; the cloud
 * runner asks the owner before each one, but for the actions the agent lets run unasked. What the session may call is read again at call
 * time: a tool taken back from the agent, or an action it no longer lists, isn't called. A Job's
 * session gets the files a call returns as the Job's attachments (`keepJobFiles`); a workflow
 * run's session, as placeholders only.
 */
export function installedToolCaller(db: Db, installed: InstalledTools, filesDir?: string): ToolCaller {
  return {
    async specs(sessionId) {
      const { httpTools } = await sessionTooling(db, sessionId);
      return httpTools.flatMap((tool) =>
        tool.actions.map((action) => ({
          key: toolKey(tool.id, action.name),
          label: `${tool.name} ${action.name}`,
          spec: { name: "", description: action.description, inputSchema: action.inputSchema },
          ...(tool.unasked.includes(action.name) ? { ask: false as const } : {}),
          ...(tool.chosen ? { always: true as const } : {}),
        })),
      );
    },
    async call(sessionId, key, args, signal) {
      if (!key.startsWith(PREFIX)) return GONE;
      const { toolId, action: actionName } = ofKey(key);
      const { httpTools, jobId, agentId } = await sessionTooling(db, sessionId);
      const tool = httpTools.find((t) => t.id === toolId);
      if (!tool?.actions.some((a) => a.name === actionName)) return GONE;
      if (typeof args !== "object" || args === null || Array.isArray(args)) return { text: "The arguments must be an object.", isError: true };
      const called = await installed.call(tool, actionName, args as Record<string, unknown>, signal);
      // A Job's call leaves its Audit row; a workflow run's session writes none.
      if (jobId) await recordToolCall(db, { ownerId: tool.ownerId, runId: jobId, agentId }, tool, actionName, called);
      if (!called.ok) return { text: called.error, isError: true };
      if (!jobId || !filesDir) return { text: called.result.text, isError: called.result.isError };
      const result = await keepJobFiles(db, filesDir, { ownerId: tool.ownerId, runId: jobId }, called.result).catch((err: unknown) => {
        logError("tool files not kept", err, { ref: jobId });
        return null;
      });
      return result ? { text: result.text, isError: result.isError } : { text: "The call ran, but the files it returned couldn't be kept.", isError: true };
    },

  };
}
