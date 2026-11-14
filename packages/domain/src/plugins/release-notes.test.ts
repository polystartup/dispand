import { expect, test } from "vitest";
import { changelogSection } from "./release-notes.ts";

const CHANGELOG = `# Changelog

## [2.1.0] - 2026-11-10

### Added
- A billing agent.

## 2.0.0

- Tables renamed.

## v1.0.0
- First.
`;

test("the section of the new version is its heading's lines, up to the next heading of the same level", () => {
  expect(changelogSection(CHANGELOG, "2.1.0")).toBe("## [2.1.0] - 2026-11-10\n\n### Added\n- A billing agent.");
  expect(changelogSection(CHANGELOG, "2.0.0")).toBe("## 2.0.0\n\n- Tables renamed.");
  // A leading v on either side matches; a version that only begins another doesn't.
  expect(changelogSection(CHANGELOG, "v1.0.0")).toBe("## v1.0.0\n- First.");
  expect(changelogSection(CHANGELOG, "1.0")).toBeNull();
  expect(changelogSection(CHANGELOG, "3.0.0")).toBeNull();
});

test("a section is cut to what a screen shows", () => {
  const long = `## 1.0.0\n${"x".repeat(30_000)}\n`;
  expect(changelogSection(long, "1.0.0")!.length).toBe(10_000);
});

test("a heading inside a code example is part of the section, not the start of the next one", () => {
  const notes = "## 2.1.0\n\nRename it like this:\n\n```md\n## New title\n```\n\n- Migrate before updating.\n\n## 2.0.0\n- Old.\n";
  expect(changelogSection(notes, "2.1.0")).toBe("## 2.1.0\n\nRename it like this:\n\n```md\n## New title\n```\n\n- Migrate before updating.");
  // Nor can one name the version.
  expect(changelogSection("```\n## 3.0.0\n```\n", "3.0.0")).toBeNull();
});
