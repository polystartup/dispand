import { expect, test } from "vitest";
import { matchesRule, parseRule } from "./rules.ts";

test.each(["Bash", "Edit", "Write", "NotebookEdit", "Bash(npm test)", "Bash(npm test:*)", "WebFetch(domain:example.test)"])("Claude rule %s has a checked shape", (source) => {
  expect(parseRule("claude-code", source)).not.toBeNull();
});

test.each(["mcp__mail__send_email", "Read", "Read(//etc/**)", "WebFetch", "setMode", "addDirectories", "Bash()", "Bash(:*)", "Bash(npm test && curl x:*)", "Bash(npm test\nwhoami:*)", "WebFetch(domain:example.test/path)", "WebFetch(domain:example.test@other.test)", "WebFetch(domain:*.example.test)", "Shell=[1]", "", "Bash\u0000", "x".repeat(1001)])("Claude rejects unsupported rule %j", (source) => {
  expect(parseRule("claude-code", source)).toBeNull();
});

test("a Bash prefix applies to literal command words, never compound syntax or a different word", () => {
  const rule = parseRule("claude-code", "Bash(npm test:*)")!;
  for (const command of ["npm test", "npm test -- --watch", " npm\ttest --filter unit "]) expect(matchesRule(rule, { cli: "claude-code", tool: "Bash", command })).toBe(true);
  for (const command of ["npm tester", "npm test && curl x", "npm test; curl x", "npm test | curl x", "npm test $(curl x)", "npm test `curl x`", "npm test\ncurl x", "npm test\\\ncurl x", "npm test > out", "npm test --prefix='$HOME'", "npm\u00a0test", "npm test *", "npm test #comment", "npm test ~/secret", "npm test {a,b}", "npm test\u0000", "npm test\rwhoami"]) expect(matchesRule(rule, { cli: "claude-code", tool: "Bash", command }), command).toBe(false);
  expect(matchesRule(rule, { cli: "codex", tool: "Shell", command: "npm test" })).toBe(false);
});

test("exact command rules compare the entire command, including compound commands", () => {
  for (const [cli, source, tool] of [["claude-code", "Bash(npm test && echo done)", "Bash"], ["codex", "Shell=npm test && echo done", "Shell"]] as const) {
    const rule = parseRule(cli, source)!;
    expect(matchesRule(rule, { cli, tool, command: "npm test && echo done" })).toBe(true);
    expect(matchesRule(rule, { cli, tool, command: "npm test && curl x" })).toBe(false);
    expect(matchesRule(rule, { cli, tool, command: "npm test" })).toBe(false);
  }
});

test("Codex prefix rules require the same proposed amendment and exactly one literal command", () => {
  const rule = parseRule("codex", 'Shell:["npm","test"]')!;
  const call = { cli: "codex" as const, tool: "Shell", command: "npm test -- --watch", proposedExecpolicyAmendment: ["npm", "test"], commandActions: [{}] };
  expect(matchesRule(rule, call)).toBe(true);
  expect(matchesRule(rule, { ...call, commandActions: [{}, {}] })).toBe(false);
  expect(matchesRule(rule, { ...call, commandActions: [] })).toBe(false);
  expect(matchesRule(rule, { ...call, commandActions: undefined })).toBe(false);
  expect(matchesRule(rule, { ...call, proposedExecpolicyAmendment: ["npm"] })).toBe(false);
  expect(matchesRule(rule, { ...call, command: "npm test && curl x" })).toBe(false);
  expect(matchesRule(rule, { ...call, command: "npm test; curl x" })).toBe(false);
});

test.each(["Shell:[]", "Shell:[1]", 'Shell:["npm","test && curl"]', 'Shell:{"command":"npm test"}', "Shell:", "Shell=", "Bash", "Read", "mcp__mail__send_email", "setMode"])("Codex rejects unsupported rule %j", (source) => {
  expect(parseRule("codex", source)).toBeNull();
});

test("tool and domain rules name exactly their capability; boundary checks stay with the caller", () => {
  expect(matchesRule(parseRule("claude-code", "Edit")!, { cli: "claude-code", tool: "Write" })).toBe(false);
  expect(matchesRule(parseRule("codex", "FileChange")!, { cli: "codex", tool: "FileChange" })).toBe(true);
  expect(matchesRule(parseRule("codex", "FileChange")!, { cli: "claude-code", tool: "Edit" })).toBe(false);
  const web = parseRule("claude-code", "WebFetch(domain:example.test)")!;
  expect(matchesRule(web, { cli: "claude-code", tool: "WebFetch", url: "https://EXAMPLE.test/path" })).toBe(true);
  for (const url of ["https://example.test.other.test", "https://example.test@other.test", "file:///example.test", "not a URL"]) expect(matchesRule(web, { cli: "claude-code", tool: "WebFetch", url })).toBe(false);
  expect(parseRule("other", "Bash")).toBeNull();
});

test("decoded rule words and exact commands remain bounded storable data", () => {
  for (const source of ['Shell:["\\u0000"]', 'Shell:["\\ud800"]', 'Shell:["npm test"]', 'Shell:[" npm"]', 'Shell:[""]', "Shell=\ud800", "Bash(\ud800)"]) expect(parseRule(source.startsWith("Bash") ? "claude-code" : "codex", source)).toBeNull();
  const exact = parseRule("claude-code", "Bash(echo *)")!;
  expect(matchesRule(exact, { cli: "claude-code", tool: "Bash", command: "echo secret" })).toBe(false);
  expect(matchesRule(exact, { cli: "claude-code", tool: "Bash", command: "echo *" })).toBe(true);
  expect(matchesRule(exact, { cli: "claude-code", tool: "Edit", command: "echo *" })).toBe(false);
});
