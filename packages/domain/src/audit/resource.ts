import type { PlatformTool } from "../platform/tools.ts";
import { AuditId, type AuditResource } from "./model.ts";

// What a platform call's Audit row is about. The type comes from the tool alone; the id only
// from what the server verified: what the call created, or the id its successful output names.
// A refused or failed call names no id: its input may be any string the agent wrote.

/** Each tool's resource, by its procedure path's first segment, or its name's for a tool that is no procedure. */
export const RESOURCE_OF: Record<string, AuditResource> = {
  tables: "table",
  rows: "row",
  fields: "field",
  agents: "agent",
  harnesses: "harness",
  workspace: "workspace",
  triggers: "trigger",
  jobs: "job",
  // A list of the workspace's workflows: no row of its own.
  workflows: "workspace",
  tools: "tool",
  plugins: "plugin",
  // Audit's own list: the workspace's record.
  audit: "workspace",
  propose: "proposal",
  proposal: "proposal",
  questions: "question",
  memory: "memory",
};

/** The key `RESOURCE_OF` holds for a tool. */
export function resourceKey(tool: PlatformTool): string {
  return (tool.path ? tool.path.split(".") : tool.name.split("_"))[0]!;
}

const idIn = (value: unknown, key: string): string | null => {
  const id = (value as Record<string, unknown> | null)?.[key];
  return AuditId.safeParse(id).success ? (id as string) : null;
};

/** The row's resource. `output`: undefined unless the call succeeded. */
export function auditResource(tool: PlatformTool, input: unknown, output: unknown): { type: AuditResource; id: string | null } {
  const type = RESOURCE_OF[resourceKey(tool)] ?? "workspace";
  if (output === undefined) return { type, id: null };
  const created = tool.creates?.id(output) ?? null;
  // `proposal_apply` succeeded: the proposal it named is one of the Job's, approved.
  const id = created ?? idIn(output, "id") ?? idIn(output, "proposalId") ?? (tool.name === "proposal_apply" ? idIn(input, "proposalId") : null);
  return { type, id: id !== null && AuditId.safeParse(id).success ? id : null };
}
