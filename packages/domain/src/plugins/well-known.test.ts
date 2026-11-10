import { afterEach, expect, test, vi } from "vitest";
import { fakeSite, skillMd } from "./test-support.ts";
import { readWellKnownIndex, readWellKnownSkills, wellKnownIndexUrl } from "./well-known.ts";

afterEach(() => vi.unstubAllGlobals());

const site = "https://skills.example";
const index = (skills: unknown[]) => JSON.stringify({ skills });

test("a site or its index gives the index URL; https only, no credentials", () => {
  expect(wellKnownIndexUrl("https://mastra.ai")).toBe("https://mastra.ai/.well-known/skills/index.json");
  expect(wellKnownIndexUrl("https://mastra.ai/")).toBe("https://mastra.ai/.well-known/skills/index.json");
  expect(wellKnownIndexUrl("https://x.example/docs/.well-known/skills/index.json")).toBe("https://x.example/docs/.well-known/skills/index.json");
  for (const bad of ["http://mastra.ai", "file:///etc", "https://u:p@x.example", "mastra.ai"]) expect(() => wellKnownIndexUrl(bad), bad).toThrow();
});

test("reads every listed skill's files and checks each skill on its own", async () => {
  const asked = fakeSite({
    [`${site}/.well-known/skills/index.json`]: index([
      { name: "greet", description: "Greets.", files: ["SKILL.md", "references/tone.md"] },
      { name: "broken", description: "No SKILL.md.", files: ["notes.md"] },
      { name: "sneaky", files: ["SKILL.md", "../../etc/passwd"] },
      { name: "Bad Name", files: ["SKILL.md"] },
    ]),
    [`${site}/.well-known/skills/greet/SKILL.md`]: skillMd("greet"),
    [`${site}/.well-known/skills/greet/references/tone.md`]: "Warm.",
    [`${site}/.well-known/skills/broken/notes.md`]: "x",
  });
  const { contents, sha } = await readWellKnownSkills(site);
  expect(contents.skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([["greet", ["greet/SKILL.md", "greet/references/tone.md"]]]);
  expect(contents.notImported).toEqual([
    { component: "skill", name: "broken", reason: "broken/SKILL.md: every skill folder needs a SKILL.md" },
    { component: "skill", name: "sneaky", reason: "One of its files has a path a skill can't hold" },
    { component: "skill", name: "Bad Name", reason: "Its name isn't lowercase letters, digits and hyphens, or is listed twice" },
  ]);
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  // The unsafe path was never requested.
  expect(asked.some((u) => u.includes("passwd") || u.includes(".."))).toBe(false);
});

test("redirects are followed on the same origin only", async () => {
  fakeSite({
    [`${site}/.well-known/skills/index.json`]: { status: 301, location: "/v2/.well-known/skills/index.json" },
    [`${site}/v2/.well-known/skills/index.json`]: index([{ name: "greet", files: ["SKILL.md"] }]),
  });
  expect((await readWellKnownIndex(site)).map((s) => s.name)).toEqual(["greet"]);
  fakeSite({
    [`${site}/.well-known/skills/index.json`]: { status: 301, location: "/v2/.well-known/skills/index.json" },
    [`${site}/v2/.well-known/skills/index.json`]: index([{ name: "greet", files: ["SKILL.md"] }]),
    [`${site}/v2/.well-known/skills/greet/SKILL.md`]: skillMd("greet"),
  });
  // Files are where the index really was.
  expect((await readWellKnownSkills(site)).contents.skills.map((s) => s.name)).toEqual(["greet"]);

  fakeSite({ [`${site}/.well-known/skills/index.json`]: { status: 302, location: "https://elsewhere.example/index.json" } });
  await expect(readWellKnownIndex(site)).rejects.toThrow("redirected the request elsewhere");
  fakeSite({ [`${site}/.well-known/skills/index.json`]: { status: 302, location: "http://skills.example/.well-known/skills/index.json" } });
  await expect(readWellKnownIndex(site)).rejects.toThrow("redirected the request elsewhere");
});

test("an index or a file too large is refused, and so is an index that isn't one", async () => {
  fakeSite({ [`${site}/.well-known/skills/index.json`]: "x".repeat(1024 * 1024 + 1) });
  await expect(readWellKnownIndex(site)).rejects.toThrow("too large");
  fakeSite({
    [`${site}/.well-known/skills/index.json`]: index([{ name: "big", files: ["SKILL.md"] }]),
    [`${site}/.well-known/skills/big/SKILL.md`]: new Uint8Array(2 * 1024 * 1024 + 1),
  });
  await expect(readWellKnownSkills(site)).rejects.toThrow("too large");
  fakeSite({ [`${site}/.well-known/skills/index.json`]: JSON.stringify({ skills: "nope" }) });
  await expect(readWellKnownIndex(site)).rejects.toThrow("isn't { skills");
  fakeSite({});
  await expect(readWellKnownIndex(site)).rejects.toThrow("answered 404");
});
