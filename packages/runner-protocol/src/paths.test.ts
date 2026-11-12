import { expect, test } from "vitest";
import { isMemoryPath, isSafeRelativePath } from "./paths.ts";

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
