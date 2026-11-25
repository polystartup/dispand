import { expect, test } from "vitest";
import { attachmentPath, isAttachmentPath, isMemoryPath, isNativePluginPath, isSafeRelativePath } from "./paths.ts";
import { parseServerMessage } from "./messages.ts";

test("accepts plain relative paths", () => {
  for (const p of ["SKILL.md", "pdf/SKILL.md", "pdf/scripts/fill.py", "a-b/c_d/e.f.txt", "x/.hidden", "x/..y"]) {
    expect(isSafeRelativePath(p), p).toBe(true);
  }
});

test("refuses unsafe paths", () => {
  for (const p of ["", "../x", "x/../y", "x/..", "/x", "/etc/x", "a//b", "a/", "a\\b", ".", "./a", "a/./b", "a/.", "a\0b"]) {
    expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
  }
});

test("refuses what the runner's boundary protects: .claude and .mcp.json, at any depth and in any case", () => {
  for (const p of [".claude/settings.json", "x/.claude/hooks/a.sh", "x/.claude", "x/.mcp.json", ".mcp.json", "x/.Claude/a", "x/.MCP.JSON"]) {
    expect(isSafeRelativePath(p), p).toBe(false);
  }
});

test("refuses control characters", () => {
  for (const p of ["a\nb", "a\rb", "a\tb", "a\u007fb"]) expect(isSafeRelativePath(p), JSON.stringify(p)).toBe(false);
});

test("caps length and depth", () => {
  expect(isSafeRelativePath("a".repeat(255))).toBe(true);
  expect(isSafeRelativePath("a".repeat(256))).toBe(false);
  expect(isSafeRelativePath(Array(10).fill("a").join("/"))).toBe(true);
  expect(isSafeRelativePath(Array(11).fill("a").join("/"))).toBe(false);
});

test("a memory path is a safe relative path to a .md file, never one a CLI loads as instructions nor the index", () => {
  for (const p of ["business.md", "notes/claude-tips.md", "x/memory.md", "clients/acme.md", `${"a".repeat(117)}.md`]) {
    expect(isMemoryPath(p), p).toBe(true);
  }
  const refused = [
    "CLAUDE.md",
    "notes/claude.md",
    "x/AGENTS.override.md",
    "AGENTS.md",
    "x/agents.md/y.md",
    ".claude/x.md",
    "../x.md",
    "/x.md",
    "a//b.md",
    "a\\b.md",
    "x.txt",
    "x.MD",
    "MEMORY.md",
    "memory.md",
    `${"a".repeat(118)}.md`,
  ];
  for (const p of refused) expect(isMemoryPath(p), JSON.stringify(p)).toBe(false);
});

test("a file named .mcp.json, CLAUDE.md or AGENTS.md gets a generated name: only its extension stays", () => {
  expect(attachmentPath("att_1", ".mcp.json")).toBe(".dispand/attachments/att_1/file.json");
  expect(attachmentPath("att_1", "CLAUDE.md")).toBe(".dispand/attachments/att_1/file.md");
  expect(attachmentPath("att_1", "AGENTS.md")).toBe(".dispand/attachments/att_1/file.md");
  expect(attachmentPath("att_1", "photo.PNG")).toBe(".dispand/attachments/att_1/file.png");
  expect(attachmentPath("att_1", "../../.claude/settings")).toBe(".dispand/attachments/att_1/file");
  expect(attachmentPath("att_1", "notes.tar.gz/../x.\u202e")).toBe(".dispand/attachments/att_1/file");
  for (const name of [".mcp.json", "CLAUDE.md", "AGENTS.md", ".codex", "a b.pdf", ""]) expect(isAttachmentPath(attachmentPath("att_1", name)), name).toBe(true);
});

test("a crafted target path naming a control file, or outside the attachments folder, is refused", () => {
  for (const p of [
    ".dispand/attachments/att_1/CLAUDE.md",
    ".dispand/attachments/att_1/agents.md",
    ".dispand/attachments/att_1/AGENTS.override.md",
    ".dispand/attachments/att_1/.mcp.json",
    ".dispand/attachments/.claude/settings.json",
    ".dispand/attachments/.codex/config.toml",
    ".dispand/attachments/att_1/../../CLAUDE.md",
    ".claude/settings.json",
    ".codex/config.toml",
    ".mcp.json",
    "CLAUDE.md",
    ".dispand/memory/workspace/a.md",
    ".dispand/attachments/att_1/a/b.txt",
    "/tmp/.dispand/attachments/att_1/file.txt",
  ]) {
    expect(isAttachmentPath(p), p).toBe(false);
    expect(() => parseServerMessage(JSON.stringify({ type: "session.send", sessionId: "ses_1", text: "hi", files: [{ attachmentId: "att_1", path: p }] })), p).toThrow();
  }
  expect(parseServerMessage(JSON.stringify({ type: "session.send", sessionId: "ses_1", text: "hi", files: [{ attachmentId: "att_1", path: ".dispand/attachments/att_1/file.md" }] }))).toMatchObject({ files: [{ path: ".dispand/attachments/att_1/file.md" }] });
});

test("a native revision may also hold the plugin root's own .mcp.json, and nothing else the rule refuses", () => {
  for (const p of [".mcp.json", "skills/a/SKILL.md", ".claude-plugin/plugin.json"]) expect(isNativePluginPath(p), p).toBe(true);
  for (const p of ["x/.mcp.json", ".MCP.json", ".claude/settings.json", "x/.claude/a", "../x", ""]) expect(isNativePluginPath(p), p).toBe(false);
});
