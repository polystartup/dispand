import fc from "fast-check";
import { expect, test } from "vitest";
import { storable } from "./bounds.ts";
import { attachmentPath, isAttachmentPath, isMemoryPath, isNativePluginPath, isSafeRelativePath } from "./paths.ts";
import { type CliRule, type CliRuleCall, MAX_CLI_RULE_LENGTH, matchesRule, parseRule } from "./rules.ts";

type Cli = CliRuleCall["cli"];
const CLIS = ["claude-code", "codex"] as const;
const TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "Shell", "FileChange", "Read", ""];
const shellTool = (cli: Cli) => (cli === "codex" ? "Shell" : "Bash");

/**
 * Plainly literal words, from an alphabet small enough that a command's words often equal a rule's.
 * Never `=` first: zsh expands `=cmd` to that command's path, so whether it is literal stays open.
 */
const word = fc.string({ unit: fc.constantFrom(..."ab1-./_="), minLength: 1, maxLength: 3 }).filter((w) => !w.startsWith("="));
const words = fc.array(word, { minLength: 1, maxLength: 3 });
/** Runs of space and tab, the only separators the literal subset knows. */
const blanks = (minLength: number) => fc.string({ unit: fc.constantFrom(" ", "\t"), minLength, maxLength: 3 });
/** `ws` separated by blank runs, with a blank run (maybe empty) at each edge. */
const spaced = (ws: string[]) =>
  fc
    .tuple(blanks(0), blanks(0), fc.array(blanks(1), { minLength: ws.length, maxLength: ws.length }))
    .map(([lead, trail, seps]) => lead + ws.map((w, i) => (i ? seps[i] : "") + w).join("") + trail);

/** What rules.ts names (quotes, expansions, redirects, comments, operators, non-ASCII whitespace), and `\r` and NUL from rules.test.ts. */
const METACHARS = [
  ..."'\"\\",
  ..."$`*?[~{}!",
  ..."<>",
  "#",
  ...";&|()\n",
  ..."\u0085\u00a0\u1680\u2000\u2003\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
  "\r",
  "\u0000",
];
/** Storable text that looks like a shell command: literal characters, blanks, metacharacters and any code point but NUL. */
const shellText = fc.string({
  unit: fc.oneof(
    fc.constantFrom(..."ab1-./_= \t"),
    fc.constantFrom(...METACHARS.filter((m) => m !== "\u0000")),
    fc.string({ unit: "binary", minLength: 1, maxLength: 1 }).filter((c) => c !== "\u0000"),
  ),
  minLength: 1,
  maxLength: 20,
});
/** A command an exact rule can hold: not blank (rules.test.ts refuses `Bash()`), and not ending in `:*`, which makes a Claude prefix rule. */
const exactCommand = shellText.filter((c) => c.trim() !== "" && !c.endsWith(":*"));

/** A prefix rule's source, for either CLI. */
const prefixSource = (cli: Cli, ws: string[]) => (cli === "codex" ? `Shell:${JSON.stringify(ws)}` : `Bash(${ws.join(" ")}:*)`);
/** A shell call whose Codex amendment and actions are those a prefix rule of `ws` requires; Claude ignores both. */
const shellCall = (cli: Cli, command: string, ws: readonly string[]): CliRuleCall => ({
  cli,
  tool: shellTool(cli),
  command,
  proposedExecpolicyAmendment: ws,
  commandActions: [{}],
});

/** Domains of one to three labels, in mixed case, the last one letters only: a numeric one reads as an IPv4 address. */
const label = fc.oneof(
  fc.constantFrom(..."aB1"),
  fc.tuple(fc.constantFrom(..."aB1"), fc.string({ unit: fc.constantFrom(..."aB1-"), maxLength: 3 }), fc.constantFrom(..."aB1")).map((parts) => parts.join("")),
);
const domain = fc
  .tuple(fc.array(label, { maxLength: 2 }), fc.string({ unit: fc.constantFrom(..."aBc"), minLength: 1, maxLength: 4 }))
  .map(([labels, last]) => [...labels, last].join("."));

/** A call `rule` is meant to allow, made from what it names. */
function witness(rule: CliRule): CliRuleCall {
  if (rule.kind === "tool") return { cli: rule.cli, tool: rule.tool };
  if (rule.kind === "domain") return { cli: rule.cli, tool: "WebFetch", url: `https://${rule.domain}/` };
  if (rule.kind === "exact") return { cli: rule.cli, tool: shellTool(rule.cli), command: rule.command };
  return shellCall(rule.cli, rule.words.join(" "), rule.words);
}

// Fixed seeds and few runs: the same inputs on every run, so a merge queue never meets a new one.

// rules.test.ts "a Bash prefix applies to literal command words, never compound syntax or a different word"
test("a prefix rule of either CLI parses to its words and matches exactly the literal commands starting with them", () => {
  const commandWords = (ws: string[]) =>
    fc.oneof(
      fc.array(word, { maxLength: 2 }).map((extra) => [...ws, ...extra]),
      fc.nat({ max: ws.length - 1 }).map((n) => ws.slice(0, n)),
      fc.array(word, { minLength: 1, maxLength: 4 }),
    );
  const cases = words.chain((ws) =>
    fc.tuple(
      fc.constant(ws),
      commandWords(ws).chain((cw) => fc.tuple(fc.constant(cw), spaced(cw))),
    ),
  );
  fc.assert(
    fc.property(fc.constantFrom(...CLIS), cases, (cli, [ws, [cw, command]]) => {
      const rule = parseRule(cli, prefixSource(cli, ws));
      expect(rule).toEqual({ cli, kind: "prefix", words: ws });
      const startsWithRule = cw.length >= ws.length && ws.every((w, i) => cw[i] === w);
      expect(matchesRule(rule!, shellCall(cli, command, ws))).toBe(startsWithRule);
    }),
    { seed: 501, numRuns: 1_000 },
  );
});

// rules.ts "Quotes, expansions, redirects, comments, operators and non-ASCII whitespace require an exact-command rule instead."
test("a prefix rule never matches a command holding a shell metacharacter, wherever it sits", () => {
  const cases = words.chain((ws) =>
    fc.tuple(
      fc.constant(ws),
      fc.array(word, { maxLength: 2 }).chain((extra) => spaced([...ws, ...extra])),
    ),
  );
  const inserts = fc.array(fc.tuple(fc.constantFrom(...METACHARS), fc.nat()), { minLength: 1, maxLength: 3 });
  fc.assert(
    fc.property(fc.constantFrom(...CLIS), cases, inserts, (cli, [ws, command], marks) => {
      const rule = parseRule(cli, prefixSource(cli, ws))!;
      expect(matchesRule(rule, shellCall(cli, command, ws))).toBe(true);
      const marked = marks.reduce((c, [mark, at]) => c.slice(0, at % (c.length + 1)) + mark + c.slice(at % (c.length + 1)), command);
      expect(matchesRule(rule, shellCall(cli, marked, ws))).toBe(false);
    }),
    { seed: 502, numRuns: 1_000 },
  );
});

// rules.test.ts "Codex prefix rules require the same proposed amendment and exactly one literal command"
test("a Codex prefix rule matches only a call proposing exactly its words, for exactly one command", () => {
  const amendments = (ws: string[]) =>
    fc.oneof(
      fc.constant(ws),
      fc.constant(ws.slice(0, -1)),
      word.map((w) => [...ws, w]),
      fc.tuple(fc.nat({ max: ws.length - 1 }), word).map(([i, w]) => ws.with(i, w)),
      fc.constant(undefined),
    );
  const actions = fc.oneof(fc.constant(undefined), fc.array(fc.constant({}), { maxLength: 3 }));
  const cases = words.chain((ws) =>
    fc.tuple(
      fc.constant(ws),
      fc.array(word, { maxLength: 2 }).chain((extra) => spaced([...ws, ...extra])),
      amendments(ws),
      actions,
    ),
  );
  fc.assert(
    fc.property(cases, ([ws, command, amendment, commandActions]) => {
      const rule = parseRule("codex", prefixSource("codex", ws))!;
      const call = { cli: "codex" as const, tool: "Shell", command, proposedExecpolicyAmendment: amendment, commandActions };
      const same = amendment !== undefined && amendment.length === ws.length && amendment.every((w, i) => w === ws[i]);
      expect(matchesRule(rule, call)).toBe(same && commandActions?.length === 1);
    }),
    { seed: 503, numRuns: 1_000 },
  );
});

// rules.test.ts "exact command rules compare the entire command, including compound commands"
test("an exact rule of either CLI holds its command as written and matches only that very string", () => {
  const nearMisses = (c: string) =>
    fc.oneof(
      fc.constant(c),
      fc.constantFrom(" ", "\t", "\n", ";", " x", " && curl x").chain((s) => fc.constantFrom(c + s, s + c)),
      fc.nat({ max: c.length - 1 }).map((i) => c.slice(0, i) + c.slice(i + 1)),
      fc.tuple(fc.nat({ max: c.length }), fc.constantFrom("a", " ", "*", "\u00a0")).map(([i, ch]) => c.slice(0, i) + ch + c.slice(i)),
      fc.tuple(fc.nat({ max: c.length - 1 }), fc.constantFrom("a", "b", " ")).map(([i, ch]) => c.slice(0, i) + ch + c.slice(i + 1)),
    );
  const cases = exactCommand.chain((c) => fc.tuple(fc.constant(c), nearMisses(c)));
  fc.assert(
    fc.property(fc.constantFrom(...CLIS), cases, (cli, [command, other]) => {
      const rule = parseRule(cli, cli === "codex" ? `Shell=${command}` : `Bash(${command})`);
      expect(rule).toEqual({ cli, kind: "exact", command });
      expect(matchesRule(rule!, { cli, tool: shellTool(cli), command: other })).toBe(other === command);
    }),
    { seed: 504, numRuns: 1_000 },
  );
});

// rules.test.ts "Claude rejects unsupported rule %j" with `"x".repeat(1001)`; rules.ts `MAX_CLI_RULE_LENGTH = 1000`.
test("a well-formed rule parses up to MAX_CLI_RULE_LENGTH characters and never past it", () => {
  const shapes = fc
    .tuple(words, fc.string({ minLength: 1, maxLength: 20 }))
    .chain(([ws, text]) =>
      fc.constantFrom<[Cli, (pad: string) => string]>(
        ["claude-code", (pad) => `Bash(${text}${pad})`],
        ["claude-code", (pad) => `Bash(${ws.join(" ")}${pad}:*)`],
        ["codex", (pad) => `Shell=${text}${pad}`],
        ["codex", (pad) => `Shell:${JSON.stringify([...ws, pad])}`],
      ),
    );
  fc.assert(
    fc.property(shapes, fc.integer({ min: MAX_CLI_RULE_LENGTH - 10, max: MAX_CLI_RULE_LENGTH + 10 }), ([cli, shape], length) => {
      const source = shape("a".repeat(length - shape("").length));
      expect(source).toHaveLength(length);
      expect(parseRule(cli, source) !== null).toBe(length <= MAX_CLI_RULE_LENGTH);
    }),
    { seed: 505, numRuns: 300 },
  );
});

// rules.test.ts "tool and domain rules name exactly their capability"; a Bash prefix refuses a Codex call, FileChange refuses a Claude call, an exact rule refuses another tool.
test("a rule matches a call it names, and never once that call's CLI or tool changes", () => {
  const sources = fc.oneof(
    fc.constantFrom<[Cli, string]>(
      ["claude-code", "Bash"],
      ["claude-code", "Edit"],
      ["claude-code", "Write"],
      ["claude-code", "NotebookEdit"],
      ["codex", "FileChange"],
    ),
    fc.tuple(fc.constantFrom(...CLIS), words).map(([cli, ws]): [Cli, string] => [cli, prefixSource(cli, ws)]),
    exactCommand.map((c): [Cli, string] => ["claude-code", `Bash(${c})`]),
    exactCommand.map((c): [Cli, string] => ["codex", `Shell=${c}`]),
    domain.map((d): [Cli, string] => ["claude-code", `WebFetch(domain:${d})`]),
  );
  fc.assert(
    fc.property(sources, fc.constantFrom(...TOOLS), ([cli, source], tool) => {
      const rule = parseRule(cli, source)!;
      expect(rule.cli).toBe(cli);
      const call = witness(rule);
      expect(matchesRule(rule, call)).toBe(true);
      expect(matchesRule(rule, { ...call, cli: cli === "codex" ? "claude-code" : "codex" })).toBe(false);
      if (tool !== call.tool) expect(matchesRule(rule, { ...call, tool })).toBe(false);
    }),
    { seed: 506, numRuns: 1_000 },
  );
});

// rules.test.ts "https://EXAMPLE.test/path" matches `WebFetch(domain:example.test)`; a longer host, userinfo, `file:` and a non-URL don't.
test("a WebFetch domain rule matches only http and https URLs whose host is its domain, in any case", () => {
  const recased = (s: string) => fc.tuple(...[...s].map((c) => fc.constantFrom(c.toLowerCase(), c.toUpperCase()))).map((cs) => cs.join(""));
  const hosts = (d: string) =>
    fc.oneof(
      recased(d).map((host) => ({ host, same: true })),
      fc.constantFrom(`x.${d}`, `${d}x`, `x${d}`, `${d}.x`, d.split(".").slice(1).join(".") || "x").map((host) => ({ host, same: false })),
    );
  const urls = (d: string) =>
    fc
      .tuple(
        fc.constantFrom("http", "https", "HTTPS", "ftp", "ws", "wss", "file"),
        fc.constantFrom("", `${d}@`, "user:pass@", `x.${d}@`),
        hosts(d),
        fc.constantFrom("", ":8080", ":443"),
        fc.constantFrom("", "/", `/${d}`, `?to=${d}`, `#${d}`),
      )
      .map(([scheme, userinfo, { host, same }, port, rest]) => ({
        url: `${scheme}://${userinfo}${host}${port}${rest}`,
        expected: same && (scheme.toLowerCase() === "http" || scheme.toLowerCase() === "https"),
      }));
  const cases = domain.chain((d) => fc.tuple(fc.constant(d), urls(d)));
  fc.assert(
    fc.property(cases, fc.constantFrom(...TOOLS.filter((t) => t !== "WebFetch")), ([d, { url, expected }], tool) => {
      const rule = parseRule("claude-code", `WebFetch(domain:${d})`)!;
      expect(rule).toEqual({ cli: "claude-code", kind: "domain", domain: d.toLowerCase() });
      expect(matchesRule(rule, { cli: "claude-code", tool: "WebFetch", url }), url).toBe(expected);
      expect(matchesRule(rule, { cli: "claude-code", tool, url })).toBe(false);
    }),
    { seed: 507, numRuns: 1_000 },
  );
});

// rules.ts "An invalid rule offers no permission."; rules.test.ts "decoded rule words and exact commands remain bounded storable data"; no rule for another CLI; and none for an empty command.
test("parseRule never throws, gives rules only to the two CLIs, and only bounded storable strings in them", () => {
  // Any UTF-16 code unit, NUL and lone surrogates often: what `storable` refuses.
  const loneSurrogates = fc.string({
    unit: fc.oneof(
      fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
      fc.constantFrom("\u0000", "\ud800", "\udfff"),
    ),
    maxLength: 12,
  });
  const text = fc.oneof(fc.string({ unit: "binary" }), loneSurrogates, shellText);
  const sources = fc.oneof(
    text,
    fc
      .tuple(
        fc.constantFrom("Bash(", "Shell:", "Shell=", "WebFetch(domain:", "Bash", "FileChange", ""),
        fc.oneof(
          text,
          domain,
          words.map((ws) => ws.join(" ")),
          fc.constant(""),
        ),
        fc.constantFrom(")", ":*)", ""),
      )
      .map((parts) => parts.join("")),
    fc.array(fc.oneof(word, text), { maxLength: 4 }).map((ws) => `Shell:${JSON.stringify(ws)}`),
    fc.jsonValue().map((v) => `Shell:${JSON.stringify(v)}`),
  );
  fc.assert(
    fc.property(fc.oneof({ arbitrary: fc.constantFrom(...CLIS), weight: 3 }, { arbitrary: fc.string(), weight: 1 }), sources, (cli, source) => {
      const rule = parseRule(cli, source);
      if (rule === null) return;
      expect(rule.cli).toBe(cli);
      expect(CLIS).toContain(cli);
      const strings = rule.kind === "prefix" ? rule.words : rule.kind === "exact" ? [rule.command] : rule.kind === "domain" ? [rule.domain] : [];
      for (const s of strings) expect(storable(s) && s.length > 0 && s.length <= MAX_CLI_RULE_LENGTH, JSON.stringify(s)).toBe(true);
    }),
    { seed: 508, numRuns: 3_000 },
  );
});

// rules.ts "an unanchored trailing-whitespace regexp retries every suffix of a long interior whitespace run when the final word is nonblank"; rules.test.ts.
test("long blank runs, inside a command or at its edges, change neither a prefix match nor its cost", () => {
  const longBlanks = fc.tuple(fc.integer({ min: 25_000, max: 50_000 }), fc.constantFrom(" ", "\t", " \t", "\t ")).map(([n, unit]) => unit.repeat(n));
  const cases = words.chain((ws) =>
    fc.tuple(
      fc.constant(ws),
      fc.tuple(fc.array(word, { maxLength: 2 }), fc.boolean()).map(([extra, bang]) => [...ws, ...extra, ...(bang ? ["!"] : [])]),
    ),
  );
  fc.assert(
    fc.property(fc.constantFrom(...CLIS), cases, longBlanks, fc.constantFrom("", " ", "edges"), (cli, [ws, cw], run, edges) => {
      const rule = parseRule(cli, prefixSource(cli, ws))!;
      const edge = edges === "edges" ? run : edges;
      const started = performance.now();
      const long = matchesRule(rule, shellCall(cli, edge + cw.join(run) + edge, ws));
      // Linear work on these few hundred thousand characters takes milliseconds; the quadratic scan rules.ts avoids, far longer.
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(long).toBe(matchesRule(rule, shellCall(cli, cw.join(" "), ws)));
    }),
    { seed: 509, numRuns: 10 },
  );
});

// paths.ts

/** Path segments that are neither empty, `.` nor `..`, from an alphabet without the letters of a config name. */
const segment = fc.string({ unit: fc.constantFrom(..."aB1_-."), minLength: 1, maxLength: 6 }).filter((s) => s !== "." && s !== "..");

// paths.ts "a safe relative path (`isSafeRelativePath`) of at most 120 characters, ending in `.md`, with no segment a CLI loads as instructions ... and not `MEMORY.md`"
test("every memory path is a safe relative path of at most 120 characters, ending in .md, with no instruction file in it", () => {
  const memorySegment = fc.oneof(
    segment,
    fc.string({ unit: fc.constantFrom(..."ab"), minLength: 10, maxLength: 30 }),
    fc.constantFrom("MEMORY.md", "memory.md", "CLAUDE.md", "Agents.md", "AGENTS.override.md", ".claude", ".Mcp.json", "a.md", ".md", "..", ".", ""),
  );
  const paths = fc.oneof(
    fc
      .tuple(fc.array(memorySegment, { minLength: 1, maxLength: 11 }), fc.constantFrom(".md", ".md", ".MD", "", "/a.md"))
      .map(([ss, end]) => ss.join("/") + end),
    fc.constantFrom("MEMORY.md", "memory.md", "Memory.Md", "a/MEMORY.md", "CLAUDE.md", "a/agents.md"),
    fc.string({ unit: "binary" }),
  );
  fc.assert(
    fc.property(paths, (p) => {
      if (!isMemoryPath(p)) return;
      expect(isSafeRelativePath(p)).toBe(true);
      expect(p.length).toBeLessThanOrEqual(120);
      expect(p.endsWith(".md")).toBe(true);
      expect(p.toLowerCase()).not.toBe("memory.md");
      for (const s of p.split("/")) expect(["claude.md", "agents.md", "agents.override.md"]).not.toContain(s.toLowerCase());
    }),
    { seed: 510, numRuns: 2_000 },
  );
});

// paths.ts "no `.claude` or `.mcp.json` segment"; "Compared without case, since macOS file systems ignore it"; only "the plugin root's own `.mcp.json`" may stay: "Anywhere else, the rule stays."
// An attachment path's fixed shape has no room for such a segment, so it isn't checked here.
test("a .claude or .mcp.json segment, in any case and at any depth, makes a path unsafe, no memory path and no native plugin path, but the plugin root's own .mcp.json", () => {
  const recased = (s: string) => fc.tuple(...[...s].map((c) => fc.constantFrom(c.toLowerCase(), c.toUpperCase()))).map((cs) => cs.join(""));
  const configs = fc.constantFrom(".claude", ".mcp.json").chain((s) => fc.oneof(fc.constant(s), recased(s)));
  fc.assert(
    // At most 8 segments, so the config segment and `a.md` stay within the 10 a safe path may have.
    fc.property(fc.array(segment, { maxLength: 8 }), configs, fc.nat(), (ss, config, at) => {
      expect(isMemoryPath([...ss, "a.md"].join("/"))).toBe(true);
      const i = at % (ss.length + 1);
      const p = [...ss.slice(0, i), config, ...ss.slice(i)].join("/");
      expect([isSafeRelativePath(p), isNativePluginPath(p), isMemoryPath(`${p}/a.md`)]).toEqual([false, p === ".mcp.json", false]);
    }),
    { seed: 511, numRuns: 1_000 },
  );
});

// paths.ts "every part made by Dispand. The original name gives only its extension (letters and digits, at most 16)"; "the one rule for the server ... and the runner".
test("attachmentPath gives a path isAttachmentPath accepts, whose file name is Dispand's and keeps only the name's extension", () => {
  const ids = fc.string({ unit: fc.constantFrom(..."aZ09_-"), minLength: 1, maxLength: 64, size: "max" });
  const stems = fc.tuple(fc.string({ unit: "binary", maxLength: 6 }), fc.constantFrom(".", "..", "/.")).map((parts) => parts.join(""));
  // `kept` is the extension the path must end in, when the name was built with one: up to 16 letters and digits, none past them.
  const names = fc.oneof(
    fc.string({ unit: "binary" }).map((name) => ({ name, kept: undefined })),
    fc.tuple(stems, fc.string({ unit: fc.constantFrom(..."aZ9é. /\u0000"), maxLength: 20 })).map(([stem, tail]) => ({ name: stem + tail, kept: undefined })),
    fc
      .tuple(stems, fc.string({ unit: fc.constantFrom(..."aZ9"), minLength: 1, maxLength: 24, size: "max" }))
      .map(([stem, ext]) => ({ name: `${stem}${ext}`, kept: ext.length <= 16 ? `.${ext}` : "" })),
  );
  fc.assert(
    fc.property(ids, names, (id, { name, kept }) => {
      const p = attachmentPath(id, name);
      expect(isAttachmentPath(p), p).toBe(true);
      const base = `.dispand/attachments/${id}/file`;
      expect(p.startsWith(base)).toBe(true);
      const ext = p.slice(base.length);
      expect(ext).toMatch(/^(\.[A-Za-z0-9]{1,16})?$/);
      expect(name.toLowerCase().endsWith(ext.toLowerCase())).toBe(true);
      if (kept !== undefined) expect(ext.toLowerCase()).toBe(kept.toLowerCase());
    }),
    { seed: 512, numRuns: 2_000 },
  );
});
