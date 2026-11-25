import type { Answer, McpServerRef, QuestionPayload } from "@dispand/runner-protocol";
import { expect, test } from "vitest";
import { PROTECTED_DENIAL } from "./boundary.ts";
import { TOOL_DISABLED, toolPolicy, type ToolPolicyOptions } from "./tool-policy.ts";

const mail: McpServerRef = { name: "mail", type: "runner", tool: "mail", unasked: ["read"], denied: ["purge"] };
const policy = (more: Partial<ToolPolicyOptions> = {}, refs: McpServerRef[] = [mail]) =>
  toolPolicy({ mcpServers: refs }, { harness: "codex", jobServer: "job", unasked: ["lookup"], bypass: false, forbidden: ["/secret"], ...more });
const call = (name: string, input: Record<string, unknown> = {}) => ({ name, input });
/** Answers every question with `answer`, keeping what was asked. */
function owner(answer: Answer | null) {
  const asked: QuestionPayload[] = [];
  return { asked, ask: async (payload: QuestionPayload) => (asked.push(payload), answer) };
}
const allow = (more: object = {}): Answer => ({ kind: "permission", decision: "allow", ...more });

test("what needs no question: disabled and protected calls are refused, Dispand's and unasked ones go through", () => {
  const tools = policy();
  expect(tools.check(call("mcp__mail__purge"))).toEqual({ deny: TOOL_DISABLED });
  expect(tools.check(call("mcp__mail__read", { path: "/secret/key" }))).toEqual({ deny: PROTECTED_DENIAL });
  expect(tools.check(call("mcp__mail__read"))).toBe("allow");
  expect(tools.check(call("mcp__job__propose"))).toBe("allow");
  expect(tools.check(call("mcp__job_tools__lookup"))).toBe("allow");
  expect(tools.check(call("mcp__job_tools__send"))).toBe("ask");
  expect(tools.check(call("mcp__mail__send"))).toBe("ask");
  expect(tools.check(call("mcp__other__thing"))).toBe("ask");
  expect(tools.disabled()).toEqual(["mcp__mail__purge"]);
});

test("a pre-approved action holds only on the server it was granted for: no other server's call reads as it", () => {
  // Codex names the server apart; its call name alone would collide with the runner tool's action `y__z`.
  const tools = policy({}, [{ name: "tool_abc", type: "runner", tool: "x", unasked: ["y__z"] }]);
  expect(tools.check({ name: "mcp__tool_abc__y__z", server: "tool_abc", input: {} })).toBe("allow");
  expect(tools.check({ name: "mcp__tool_abc__y__z", server: "tool_abc__y", input: {} })).toBe("ask");
  // The Job's tools: same.
  expect(tools.check({ name: "mcp__job_tools__lookup", server: "job_tools", input: {} })).toBe("allow");
  expect(tools.check({ name: "mcp__job_tools__lookup", server: "job_tools_2", input: {} })).toBe("ask");
  // Claude Code's names: the first segment is the server, read exactly.
  const claude = policy({ harness: "claude-code" }, [{ name: "tool_abc", type: "runner", tool: "x", unasked: ["y"] }]);
  expect(claude.check(call("mcp__tool_abc__y"))).toBe("allow");
  expect(claude.check(call("mcp__tool_abcd__y"))).toBe("ask");
});

test("an approval the owner remembers holds on its own server only", async () => {
  const tools = policy({}, [{ name: "tool_abc", type: "runner", tool: "x" }]);
  await tools.decide({ name: "mcp__tool_abc__y__z", server: "tool_abc", input: {} }, owner(allow({ remember: true })).ask);
  expect(tools.check({ name: "mcp__tool_abc__y__z", server: "tool_abc", input: {} })).toBe("allow");
  expect(tools.check({ name: "mcp__tool_abc__y__z", server: "tool_abc__y", input: {} })).toBe("ask");
});

test("a server the CLI names apart is matched by that name, never by the tool name's prefix", () => {
  const tools = policy();
  // Server `job__x` isn't Dispand's `job`, whatever its tool is called.
  expect(tools.check({ name: "mcp__job__x__y", server: "job__x", input: {} })).toBe("ask");
  expect(tools.check({ name: "mcp__job__y", server: "job", input: {} })).toBe("allow");
});

test("bypass skips the question for other servers' tools, never for the agent's own", async () => {
  const tools = policy({ bypass: true });
  expect(tools.check(call("mcp__other__thing"))).toBe("allow");
  expect(tools.check(call("mcp__mail__send"))).toBe("ask");
  expect(tools.check(call("mcp__mail__purge"))).toEqual({ deny: TOOL_DISABLED });
});

test("each call asks the owner; a plain yes or no grants nothing for the next one", async () => {
  const tools = policy();
  const yes = owner(allow());
  expect(await tools.decide(call("mcp__mail__send", { to: "a" }), yes.ask)).toEqual({ allow: true });
  expect(yes.asked).toEqual([{ kind: "permission", toolName: "mcp__mail__send", input: { to: "a" }, canAlwaysAllow: true }]);
  expect(await tools.decide(call("mcp__mail__send"), owner({ kind: "permission", decision: "deny", message: "Not now" }).ask)).toEqual({ allow: false, message: "Not now" });
  expect(await tools.decide(call("mcp__mail__send"), owner(null).ask)).toEqual({ allow: false, message: "The owner denied this." });
  expect(tools.check(call("mcp__mail__send"))).toBe("ask");
  // Another server's tool can't be allowed for good from here; without a Job, neither can the agent's.
  const other = owner(allow());
  await tools.decide(call("mcp__other__thing"), other.ask);
  expect(other.asked[0]).toMatchObject({ canAlwaysAllow: false });
  const noJob = owner(allow());
  await toolPolicy({ mcpServers: [mail] }, { harness: "codex", bypass: false, forbidden: [] }).decide(call("mcp__mail__send"), noJob.ask);
  expect(noJob.asked[0]).toMatchObject({ canAlwaysAllow: false });
});

test("a remembered answer about the agent's tool lasts for the session; about another server's it doesn't", async () => {
  const tools = policy();
  await tools.decide(call("mcp__mail__send"), owner(allow({ remember: "run" })).ask);
  expect(tools.check(call("mcp__mail__send"))).toBe("allow");
  await tools.decide(call("mcp__mail__draft"), owner({ kind: "permission", decision: "allow-always" }).ask);
  expect(tools.check(call("mcp__mail__draft"))).toBe("allow");
  expect(await tools.decide(call("mcp__mail__archive"), owner({ kind: "permission", decision: "deny", remember: "run" }).ask)).toMatchObject({ allow: false });
  expect(tools.check(call("mcp__mail__archive"))).toEqual({ deny: TOOL_DISABLED });
  await tools.decide(call("mcp__other__thing"), owner(allow({ remember: "run" })).ask);
  expect(tools.check(call("mcp__other__thing"))).toBe("ask");
});

test("narrowing only takes away, and voids a lasting yes to a question asked before it", async () => {
  const tools = policy();
  let answer!: (a: Answer) => void;
  const pending = tools.decide(call("mcp__mail__send"), () => new Promise<Answer>((resolve) => (answer = resolve)));
  tools.narrow([{ name: "mail", unasked: ["read", "send"], denied: ["draft"] }]);
  answer({ kind: "permission", decision: "allow-always" });
  // This call goes through, as the owner said; the next one asks again.
  expect(await pending).toEqual({ allow: true });
  expect(tools.check(call("mcp__mail__send"))).toBe("ask");
  expect(tools.check(call("mcp__mail__draft"))).toEqual({ deny: TOOL_DISABLED });
  // A server the update no longer lists is gone whole, even if disabled while the owner answers.
  const late = tools.decide(call("mcp__mail__archive"), async () => (tools.narrow([]), allow()));
  expect(await late).toEqual({ allow: false, message: TOOL_DISABLED });
  expect(tools.check(call("mcp__mail__read"))).toEqual({ deny: TOOL_DISABLED });
});

test("an input the owner couldn't see whole isn't asked about", async () => {
  const none = owner(allow());
  expect(await policy().decide(call("mcp__mail__send", { body: "x".repeat(2_000_000) }), none.ask)).toMatchObject({ allow: false, message: expect.stringContaining("too large") });
  expect(none.asked).toEqual([]);
});
