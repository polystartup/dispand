import { expect, test } from "vitest";
import { MAX_FILE_BYTES, MAX_FILES, PackageError, skillMd, type SkillFile, validatePackage } from "./package.ts";

const text = (s: string) => new TextEncoder().encode(s);
const file = (path: string, content: string | Uint8Array = ""): SkillFile => ({ path, content: typeof content === "string" ? text(content) : content });
const md = (name: string, description = "Does a thing.") => file(`${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`);

function refusal(files: SkillFile[]): PackageError {
  try {
    validatePackage(files);
  } catch (e) {
    if (e instanceof PackageError) return e;
    throw e;
  }
  throw new Error("accepted");
}

test("a package lists its skills from their frontmatter", () => {
  expect(validatePackage([md("pdf", "Fill PDF forms."), file("pdf/scripts/fill.py", "print(1)"), md("xlsx")])).toEqual({
    skills: [
      { name: "pdf", description: "Fill PDF forms." },
      { name: "xlsx", description: "Does a thing." },
    ],
  });
});

test("refuses unsafe paths", () => {
  for (const path of ["../x", "/x", "pdf//b", "pdf\\b", ".", "pdf/./b", "pdf/a\0b", "pdf/../x", "pdf/.claude/settings.json", "pdf/.mcp.json"]) {
    const e = refusal([md("pdf"), file(path)]);
    expect(e.path, path).toBe(path);
  }
});

test("a file outside any skill folder is refused", () => {
  expect(refusal([md("pdf"), file("README.md")]).path).toBe("README.md");
});

test("a folder without SKILL.md is refused", () => {
  const e = refusal([md("pdf"), file("docx/notes.md", "x")]);
  expect(e.path).toBe("docx/SKILL.md");
  expect(e.message).toMatch(/SKILL\.md/);
});

test("an empty package is refused", () => {
  expect(() => validatePackage([])).toThrow(PackageError);
});

test("frontmatter name must match its folder", () => {
  const e = refusal([file("pdf/SKILL.md", "---\nname: docx\ndescription: x\n---\n")]);
  expect(e.path).toBe("pdf/SKILL.md");
  expect(e.message).toMatch(/name/);
});

test("frontmatter needs a description, and YAML that parses", () => {
  for (const content of [
    "---\nname: pdf\n---\nbody",
    "---\nname: pdf\ndescription: ''\n---\n",
    "no frontmatter",
    "---\nname: pdf\ndescription: [unclosed\n---\n",
    "---\nname: pdf\ndescription: x\n",
    "---\n- a list\n---\n",
    '---\nname: pdf\ndescription: "a\\0b"\n---\n',
  ]) {
    expect(refusal([file("pdf/SKILL.md", content)]).path, content).toBe("pdf/SKILL.md");
  }
});

test("folder names follow the skill name rule", () => {
  for (const name of ["PDF", "-pdf", "p_df", "a".repeat(65)]) {
    expect(refusal([file(`${name}/SKILL.md`, `---\nname: ${name}\ndescription: x\n---\n`)]).path).toBe(`${name}/SKILL.md`);
  }
});

test("caps refuse 501 files and a 2 MiB + 1 file", () => {
  const many = [md("pdf"), ...Array.from({ length: MAX_FILES }, (_, i) => file(`pdf/f${i}`))];
  expect(many).toHaveLength(501);
  expect(() => validatePackage(many.slice(0, MAX_FILES))).not.toThrow();
  expect(() => validatePackage(many)).toThrow(/500 files/);
  expect(() => validatePackage([md("pdf"), file("pdf/big.bin", new Uint8Array(MAX_FILE_BYTES))])).not.toThrow();
  expect(refusal([md("pdf"), file("pdf/big.bin", new Uint8Array(MAX_FILE_BYTES + 1))]).path).toBe("pdf/big.bin");
});

test("caps refuse more than 8 MiB in all", () => {
  const files = [md("pdf"), ...Array.from({ length: 5 }, (_, i) => file(`pdf/f${i}`, new Uint8Array(MAX_FILE_BYTES)))];
  expect(() => validatePackage(files)).toThrow(/8 MiB/);
});

test("a path given twice, even in another case, or a file where a folder is, is refused", () => {
  expect(refusal([md("pdf"), file("pdf/a.txt"), file("pdf/A.txt")]).path).toBe("pdf/A.txt");
  expect(refusal([md("pdf"), file("pdf/a"), file("pdf/a/b")]).path).toMatch(/^pdf\/a/);
});

test("skillMd writes a frontmatter validatePackage reads back", () => {
  const description = 'Quotes "here", a colon: and\nnew lines # not a comment';
  const content = skillMd("pdf", description, "# Steps\n\nDo it.");
  expect(validatePackage([{ path: "pdf/SKILL.md", content }])).toEqual({ skills: [{ name: "pdf", description }] });
  expect(new TextDecoder().decode(content)).toMatch(/\n---\n\n# Steps\n\nDo it.\n$/);
});
