import { expect, test } from "vitest";
import { nativeCode, nativeReview } from "./native-code.ts";

const files = (map: Record<string, string>) => Object.entries(map).map(([path, text]) => ({ path, content: new TextEncoder().encode(text) }));
const kinds = (entries: ReturnType<typeof nativeCode>) => entries.map((e) => `${e.kind} ${e.label}: ${e.text ?? "-"}`);

test("hooks and servers are read from every declaration the runner reads, with the files they run", () => {
  const plugin = files({
    ".mcp.json": JSON.stringify({ mcpServers: { echo: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], env: { TOKEN: "secret-value-1" } } } }),
    ".claude-plugin/plugin.json": JSON.stringify({ name: "p", mcpServers: { inline: { command: "./bin/run.sh" } }, hooks: "./more-hooks.json" }),
    "hooks/hooks.json": JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/stamp.sh" }] }], PreToolUse: [{ hooks: [{ type: "command", command: "echo allow" }] }] } }),
    "more-hooks.json": JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "./setup.sh" }] }] } }),
    "server.mjs": "console.log('echo');",
    "bin/run.sh": "#!/bin/sh\nexec node x.js",
    "hooks/stamp.sh": "echo stamped",
    "setup.sh": "touch ready",
    "README.md": "not run",
  });
  const shown = kinds(nativeCode(plugin));
  expect(shown).toEqual(expect.arrayContaining([
    "server echo: node ${CLAUDE_PLUGIN_ROOT}/server.mjs\nenv: TOKEN",
    "server inline: ./bin/run.sh",
    "hook UserPromptSubmit: bash ${CLAUDE_PLUGIN_ROOT}/hooks/stamp.sh",
    "hook SessionStart (startup): ./setup.sh",
    "file server.mjs: console.log('echo');",
    "file bin/run.sh: #!/bin/sh\nexec node x.js",
    "file hooks/stamp.sh: echo stamped",
    "file setup.sh: touch ready",
  ]));
  // A permission hook never runs (the runner leaves it out); a file nothing names isn't listed; no env value ever.
  expect(shown.join("\n")).not.toContain("echo allow");
  expect(shown.join("\n")).not.toContain("README");
  expect(JSON.stringify(nativeCode(plugin))).not.toContain("secret-value-1");
});

test("a bare server map, a wrapped one and a declaration the runner can't read", () => {
  expect(kinds(nativeCode(files({ "mcp.json": JSON.stringify({ bare: { command: "uvx", args: ["tool"] } }) })))).toEqual(["server bare: uvx tool"]);
  expect(kinds(nativeCode(files({ ".mcp.json": "[1, 2]", "hooks.json": "not json" })))).toEqual(["unreadable .mcp.json: -", "unreadable hooks.json: -"]);
});

test("a long file is cut and says so; a revision against the pinned one lists every changed file", () => {
  const long = "x".repeat(25_000);
  const [file] = nativeCode(files({ ".mcp.json": JSON.stringify({ s: { command: "node", args: ["big.js"] } }), "big.js": long })).filter((e) => e.kind === "file");
  expect(file!.text).toContain("more characters");
  const pinned = files({ "hooks/hooks.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./a.sh" }] }] } }), "a.sh": "one", "lib.js": "old" });
  const next = files({ "hooks/hooks.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./a.sh" }] }] } }), "a.sh": "two", "lib.js": "new" });
  const review = nativeReview(pinned, next);
  expect(review.changed).toBe(true);
  expect(review.before.find((e) => e.label === "a.sh")!.text).toBe("one");
  expect(review.after.find((e) => e.label === "a.sh")!.text).toBe("two");
  // A file no command names, but changed: on the screen too (a server may import it).
  expect(review.after.find((e) => e.label === "lib.js")!.text).toBe("new");
  expect(nativeReview(pinned, pinned).changed).toBe(false);
});
