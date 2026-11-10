import { describe, expect, it } from "vitest";
import { toolNames } from "./tool-names.ts";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

describe("toolNames", () => {
  it("gives distinct names to two actions that slug to the same name", () => {
    const names = toolNames([
      { key: "a", label: "github: create repo" },
      { key: "b", label: "github create/repo" },
    ]);
    expect(names.toName("a")).not.toBe(names.toName("b"));
    expect(names.toName("a")).toMatch(VALID);
    expect(names.toName("b")).toMatch(VALID);
    expect(names.fromName(names.toName("a"))).toBe("a");
    expect(names.fromName(names.toName("b"))).toBe("b");
  });

  it("cuts a 100-character action name to 64 and keeps it unique", () => {
    const long = "x".repeat(100);
    const names = toolNames([
      { key: "a", label: long },
      { key: "b", label: long },
    ]);
    for (const key of ["a", "b"]) {
      expect(names.toName(key)).toMatch(VALID);
      expect(names.toName(key).length).toBeLessThanOrEqual(64);
    }
    expect(names.toName("a")).not.toBe(names.toName("b"));
  });

  it("never produces a reserved name", () => {
    const names = toolNames([
      { key: "a", label: "ask_user" },
      { key: "b", label: "submit outputs" },
      { key: "c", label: "read-skill" },
      { key: "d", label: "READ_SKILL" },
    ]);
    const produced = ["a", "b", "c", "d"].map((k) => names.toName(k));
    for (const name of produced) {
      expect(["ask_user", "submit_outputs", "request_approval", "read_skill"]).not.toContain(name);
      expect(name).toMatch(VALID);
    }
    expect(new Set(produced).size).toBe(4);
    expect(names.fromName("ask_user")).toBeUndefined();
  });

  it("is stable for a given list", () => {
    const refs = [
      { key: "a", label: "Search the web" },
      { key: "b", label: "Search the web" },
      { key: "c", label: "été" },
    ];
    const first = refs.map((r) => toolNames(refs).toName(r.key));
    const second = refs.map((r) => toolNames(refs).toName(r.key));
    expect(first).toEqual(second);
    expect(first[2]).toMatch(VALID);
  });

  it("throws for a key it wasn't given", () => {
    expect(() => toolNames([]).toName("nope")).toThrow();
  });
});
