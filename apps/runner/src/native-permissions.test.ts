import { expect, test } from "vitest";
import { nativePermissions, nativeRuleForCall } from "./native-permissions.ts";

test("native policies discard other capabilities, keep deny precedence and require a matching offered rule", () => {
  const policy = nativePermissions("claude-code", { allow: ["mcp__mail__send", "Read(//etc/**)", "setMode", "addDirectories", "Bash", "Shell=npm test"], deny: ["Bash(npm test:*)"] });
  const call = { cli: "claude-code" as const, tool: "Bash", command: "npm test" };
  expect(policy.decision(call)).toBe("deny");
  expect(policy.decision({ ...call, tool: "mcp__mail__send" })).toBeNull();
  expect(policy.decision({ ...call, tool: "Read" })).toBeNull();
  policy.remember("Edit", call, { kind: "permission", decision: "allow", remember: "always" });
  expect(policy.decision(call)).toBe("deny");
  policy.remember("Bash(npm test:*)", call, { kind: "permission", decision: "allow", remember: "run" });
  expect(policy.decision(call)).toBe("allow");
});

test("candidate offers match the current CLI and call; unsafe prefixes fall back to exact commands", () => {
  const claude = { cli: "claude-code" as const, tool: "Bash", command: "npm test" };
  expect(nativeRuleForCall(claude, ["Bash(curl:*)", "Read", "Bash(npm test:*)"])).toBe("Bash(npm test:*)");
  expect(nativeRuleForCall({ ...claude, command: "npm test && curl x" }, ["Bash(npm test:*)"])).toBe("Bash(npm test && curl x)");
  expect(nativeRuleForCall({ ...claude, tool: "mcp__mail__send" })).toBeNull();
  expect(nativeRuleForCall({ ...claude, tool: "Read" })).toBeNull();
  expect(nativeRuleForCall({ ...claude, command: "x".repeat(1001) })).toBeNull();
  const codex = { cli: "codex" as const, tool: "Shell", command: "npm test", proposedExecpolicyAmendment: ["npm", "test"], commandActions: [{}] };
  expect(nativeRuleForCall(codex)).toBe('Shell:["npm","test"]');
  expect(nativeRuleForCall({ ...codex, commandActions: [{}, {}] })).toBe("Shell=npm test");
  expect(nativeRuleForCall({ ...codex, command: "npm test && curl x" })).toBe("Shell=npm test && curl x");
});
