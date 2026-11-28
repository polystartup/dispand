// `toolVerdict`: the one ordered verdict both of Claude Code's permission phases follow, over
// every permission mode and every answer of the tool policy, the file boundary and native rules.
import { ClaudePermissionMode, TOOL_TEXTS } from "@dispand/runner-protocol";
import { expect, test } from "vitest";
import { PROTECTED_DENIAL, READ_ASK, READ_DENIAL } from "./boundary.ts";
import { type ToolVerdict, toolVerdict } from "./claude.ts";
import { TOOL_DISABLED } from "./tool-policy.ts";

type Decision = "allow" | "deny" | "ask" | "n/a";
type Facts = {
  /** What the tool policy says (`check`); by default what it says of any tool but an agent's: ask, or allow in bypass. */
  policy?: "allow" | "ask" | { deny: string };
  edit?: Decision;
  read?: Decision;
  native?: "allow" | "deny" | null;
  /** Whether the session offers `ask`. */
  asks?: boolean;
  /** Whether the turn's approval request, if any, was approved. */
  approved?: boolean;
};

const MODES = ClaudePermissionMode.options;

const verdict = (mode: (typeof MODES)[number], name: string, facts: Facts = {}): Promise<ToolVerdict> =>
  toolVerdict(
    {
      start: { permissionMode: mode },
      tools: {
        check: () => facts.policy ?? (mode === "bypassPermissions" ? "allow" : "ask"),
        decide: () => Promise.reject(new Error("not a verdict's")),
      },
      boundary: { editDecision: () => facts.edit ?? "n/a", readDecision: () => facts.read ?? "n/a", sessionUpdates: () => [] },
      native: { decision: () => facts.native ?? null, remember: () => {} },
      ask: () => Promise.reject(new Error("not a verdict's")),
      asks: facts.asks ?? true,
      expectApproval: () => {},
      turnApproved: async () => facts.approved ?? true,
      isRelayed: (name) => name.startsWith("mcp__relayed__"),
    },
    name,
    {},
    "/work",
  );

const deny = (reason: string): ToolVerdict => ({ decision: "deny", reason });
const ALLOW: ToolVerdict = { decision: "allow" };
const NATIVE_DENIAL = "This native CLI rule is denied for this session.";
const SHELL_ASK = "Dispand asks the owner about every shell command.";
const MCP_ASK = "Dispand asks the owner about every MCP tool call.";

/**
 * Each row: a call and what is known of it, then its verdict in every mode, or in bypass and in
 * the others when they differ. The rows go down the verdict's order: each one's answer beats
 * every row below it.
 */
const ROWS: [string, string, Facts, ToolVerdict | { bypass: ToolVerdict; others: ToolVerdict }][] = [
  // 1. A turn whose approval request was denied runs nothing else, whatever would allow it.
  ["a call after a denied approval", "Read", { approved: false, read: "allow" }, deny(TOOL_TEXTS.notRunAfterDenial)],
  ["an MCP call after a denied approval", "mcp__srv__act", { approved: false, policy: "allow" }, deny(TOOL_TEXTS.notRunAfterDenial)],
  ["another approval request after a denied one", "mcp__dispand__request_approval", { approved: false }, { decision: "cli", then: "allow" }],
  // 2. The tool policy's refusals, before anything that would let the call through.
  ["a disabled action", "mcp__srv__act", { policy: { deny: TOOL_DISABLED } }, deny(TOOL_DISABLED)],
  ["a disabled relayed action", "mcp__relayed__act", { policy: { deny: TOOL_DISABLED } }, deny(TOOL_DISABLED)],
  ["a runner tool's protected argument", "mcp__srv__act", { policy: { deny: PROTECTED_DENIAL } }, deny(PROTECTED_DENIAL)],
  // 3. Dispand's own tools: the CLI's word, and allowed if it asks.
  ["submit_outputs", "mcp__dispand__submit_outputs", {}, { decision: "cli", then: "allow" }],
  ["request_approval", "mcp__dispand__request_approval", {}, { decision: "cli", then: "allow" }],
  ["ask, offered", "mcp__dispand__ask", { asks: true }, { decision: "cli", then: "allow" }],
  ["ask, not offered", "mcp__dispand__ask", { asks: false }, { bypass: { decision: "cli", then: "allow" }, others: { decision: "cli", then: "tool" } }],
  // 4. A relayed tool: the relay decides at the call.
  ["a relayed tool", "mcp__relayed__act", { policy: "ask" }, ALLOW],
  // 5. Any other MCP call: one question each, whatever a rule says; one the policy allows is the CLI's, then the policy's.
  ["an MCP call the policy asks about", "mcp__srv__act", { policy: "ask" }, { decision: "ask", reason: MCP_ASK, question: "mcp" }],
  ["an MCP call the policy allows", "mcp__srv__act", { policy: "allow" }, { decision: "cli", then: "mcp" }],
  // 6. The file boundary's refusals and allowed reads.
  ["an edit outside the folder", "Edit", { edit: "deny", native: "allow" }, deny(PROTECTED_DENIAL)],
  ["a read outside the allowlist", "Read", { read: "deny" }, deny(READ_DENIAL)],
  ["a read inside the allowlist", "Read", { read: "allow" }, ALLOW],
  // 7. A native rule's denial, even where the boundary can't tell.
  ["a command a native rule denies", "Bash", { native: "deny" }, deny(NATIVE_DENIAL)],
  ["an unplain edit a native rule denies", "Edit", { edit: "ask", native: "deny" }, deny(NATIVE_DENIAL)],
  // 8. A path the boundary can't decide on: the owner, never a rule or bypass.
  ["an unplain edit a native rule allows", "Edit", { edit: "ask", native: "allow" }, { decision: "ask", reason: READ_ASK, question: "unsure" }],
  ["an LSP call", "LSP", { read: "ask" }, { decision: "ask", reason: READ_ASK, question: "unsure" }],
  // 9. AskUserQuestion: the owner's choices.
  ["AskUserQuestion", "AskUserQuestion", {}, { decision: "cli", then: "choices" }],
  // 10. A native rule's allowance.
  ["a command a native rule allows", "Bash", { native: "allow" }, ALLOW],
  ["an edit in the folder a native rule allows", "Edit", { edit: "allow", native: "allow" }, ALLOW],
  // 11. Every shell command goes to the owner outside bypass; 12. bypass, then the CLI's mode.
  ["a command", "Bash", {}, { bypass: { decision: "cli", then: "allow" }, others: { decision: "ask", reason: SHELL_ASK, question: "tool" } }],
  ["a script", "Workflow", {}, { bypass: { decision: "cli", then: "allow" }, others: { decision: "ask", reason: SHELL_ASK, question: "tool" } }],
  ["an edit in the folder", "Edit", { edit: "allow" }, { bypass: { decision: "cli", then: "allow" }, others: { decision: "cli", then: "tool" } }],
  ["a fetch", "WebFetch", {}, { bypass: { decision: "cli", then: "allow" }, others: { decision: "cli", then: "tool" } }],
  ["any other tool", "TodoWrite", {}, { bypass: { decision: "cli", then: "allow" }, others: { decision: "cli", then: "tool" } }],
];

test("modes and rows: every permission mode is covered, and every row is told apart", () => {
  expect(MODES).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  expect(new Set(ROWS.map(([name]) => name)).size).toBe(ROWS.length);
});

test.each(ROWS.flatMap(([name, tool, facts, expected]) => MODES.map((mode) => [name, mode, tool, facts, expected] as const)))(
  "%s, in %s",
  async (_name, mode, tool, facts, expected) => {
    const want = "bypass" in expected ? (mode === "bypassPermissions" ? expected.bypass : expected.others) : expected;
    expect(await verdict(mode, tool, facts)).toEqual(want);
  },
);

test("the policy is read after the turn's approval is known: a narrowing that came meanwhile counts", async () => {
  let disabled = false;
  const decided = toolVerdict(
    {
      start: { permissionMode: "default" },
      tools: { check: () => (disabled ? { deny: TOOL_DISABLED } : "ask"), decide: () => Promise.reject(new Error("unused")) },
      boundary: { editDecision: () => "n/a", readDecision: () => "n/a", sessionUpdates: () => [] },
      native: { decision: () => null, remember: () => {} },
      ask: () => Promise.reject(new Error("unused")),
      asks: true,
      expectApproval: () => {},
      turnApproved: () => new Promise((resolve) => setTimeout(() => resolve(true), 10)),
      isRelayed: () => false,
    },
    "mcp__srv__act",
    {},
    null,
  );
  disabled = true;
  expect(await decided).toEqual(deny(TOOL_DISABLED));
});
