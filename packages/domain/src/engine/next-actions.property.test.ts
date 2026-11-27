import fc from "fast-check";
import { expect, test } from "vitest";
import { CONDITION_OPS, evaluateCondition } from "../workflows/condition.ts";
import { itemValues, parseList } from "../workflows/loop.ts";
import { references } from "../workflows/template.ts";
import { nodesOf, type Edge, type LoopStep, type Ref, type Step, type WorkflowDef, type WorkflowNode } from "../workflows/model.ts";
import { nextActions, outputsFor, toolValues, valuesFor, type Action, type StepState } from "./next-actions.ts";

type Status = StepState["status"];
type Kind = "agent" | "condition" | "data" | "tool";
type Firing = Parameters<typeof nextActions>[2];
type Case = { def: WorkflowDef; steps: StepState[]; trigger: Firing };

// Ids, keys and fields an object answers to by itself, among plain ones: they must stay own properties.
const IDS = ["constructor", "__proto__", "toString", ...Array.from({ length: 21 }, (_, i) => `n${i}`)];
const KEYS = ["constructor", "__proto__", ...Array.from({ length: 21 }, (_, i) => `k${i}`)];
const FIELDS = ["toString", "valueOf", "hasOwnProperty", "constructor", "__proto__", "x", "y"];
const WHEN = new Date("2026-01-01T09:00:00Z");
const DONE: Status[] = ["succeeded", "skipped"];

const texts = fc.constantFrom("", "yes", " Yes ", "3", "10", "abc");
const fields = (names: string[]) =>
  fc
    .uniqueArray(fc.tuple(fc.constantFrom(...names), texts), { selector: ([k]) => k, maxLength: 3 })
    .map((pairs) => Object.fromEntries(pairs) as Record<string, string>);
const items = fc.array(fc.oneof(texts, fc.integer({ min: -3, max: 3 }), fields(["name", "item", "index", "__proto__", "constructor"])), { maxLength: 3 });
/** A node's outputs: a few fields, some named like Object's own, and `list`, a JSON array a loop can read. */
const outputs = fc.tuple(fields(FIELDS), items).map(([o, list]) => ({ ...o, list: JSON.stringify(list) }));
const firing: fc.Arbitrary<Firing> = fc.option(
  fc.option(outputs, { nil: undefined }).map((o) => (o ? { scheduledFor: WHEN, outputs: o } : { scheduledFor: WHEN })),
  { nil: undefined },
);

const kinds = fc.constantFrom<Kind>("agent", "condition", "data", "tool");
const shapes = fc.record({
  trigger: fc.constantFrom("button", "chat", "schedule"),
  top: fc.array(fc.record({ kind: fc.oneof(kinds, fc.constant("loop" as const)), body: fc.array(kinds, { minLength: 1, maxLength: 3 }) }), { maxLength: 5 }),
});

/**
 * Definitions `structuralIssues` accepts: unique ids and keys, links forward inside one scope (the top
 * level or one loop's body, never into the trigger), a branch on each link out of a condition and on
 * no other, loops not nested and never empty. A loop's list is an earlier node's `list`, linked to it.
 */
const defs: fc.Arbitrary<WorkflowDef> = shapes.chain(({ trigger, top }) => {
  const specs: { kind: Kind | "loop" | "trigger"; loop?: number }[] = [{ kind: "trigger" }, ...top.map((t) => ({ kind: t.kind }))];
  top.forEach((t, i) => t.kind === "loop" && specs.push(...t.body.map((kind) => ({ kind, loop: i + 1 }))));
  const n = specs.length;
  const earlier = (j: number) => specs.flatMap((s, i) => (i < j && s.loop === specs[j]!.loop ? [i] : []));
  // What a node reads is mostly what it sees (the top level, its loop and its loop's body), now and then any node.
  const visible = (i: number) => specs.flatMap((s, j) => (s.loop === undefined || s.loop === specs[i]!.loop ? [j] : []));
  const field = fc.oneof({ arbitrary: fc.constant("list"), weight: 2 }, { arbitrary: fc.constantFrom(...FIELDS, "index"), weight: 3 });
  const detail = (i: number) => {
    const loop = specs[i]!.loop;
    const source = (max: number) => fc.oneof({ arbitrary: fc.constantFrom(...visible(i)), weight: 4 }, { arbitrary: fc.nat({ max }), weight: 1 });
    const ref = fc.oneof(
      { arbitrary: fc.tuple(source(n - 1), field), weight: 5 },
      ...(loop === undefined ? [] : [{ arbitrary: fc.constant([loop, "index"] as [number, string]), weight: 1 }]),
    );
    return fc.record({
      // `n` names no node: "nobody".
      refs: fc.array(fc.tuple(source(n), fc.constantFrom(...FIELDS)), { maxLength: 4 }),
      value: fc.option(ref, { nil: null }),
      op: fc.constantFrom(...CONDITION_OPS),
      operand: texts,
      list: fc.nat(),
      max: fc.integer({ min: 1, max: 4 }),
      inputs: fc.uniqueArray(fc.tuple(fc.constantFrom("p1", "p2", "p3", "p4"), fc.oneof(texts, ref)), { selector: ([p]) => p, maxLength: 4 }),
    });
  };
  // Each node follows one or two earlier nodes of its scope (a join), but a scope's first; conditions
  // weigh double, so that their branches lead somewhere.
  const conditions = (j: number) => earlier(j).filter((i) => specs[i]!.kind === "condition");
  const into = (j: number) =>
    fc.uniqueArray(fc.tuple(fc.constantFrom(-1, ...earlier(j), ...conditions(j)), fc.constantFrom("then" as const, "else" as const)), {
      selector: ([i]) => i,
      minLength: earlier(j).length > 0 ? 1 : 0,
      maxLength: Math.min(2, earlier(j).length),
    });
  return fc
    .record({
      // The pools' first names (Object's) are in every definition that has room for them.
      ids: fc.shuffledSubarray(IDS.slice(0, Math.max(n, 3)), { minLength: n, maxLength: n }),
      keys: fc.shuffledSubarray(KEYS.slice(0, Math.max(n, 2)), { minLength: n, maxLength: n }),
      links: fc.tuple(...specs.map((_, j) => into(j))),
      details: fc.tuple(...specs.map((_, i) => detail(i))),
    })
    .map(({ ids, keys, links, details }) => {
      const refOf = ([i, name]: readonly [number, string]): Ref => ({ type: "output", nodeId: ids[i]!, name });
      const prompt = (i: number) => details[i]!.refs.map(([j, field]) => `{{${keys[j] ?? "nobody"}.${field}}}`).join(" ");
      const edges: Edge[] = links.flatMap((from, j) =>
        from.flatMap(([i, branch]) => (i < 0 ? [] : [{ from: ids[i]!, to: ids[j]!, ...(specs[i]!.kind === "condition" ? { branch } : {}) }])),
      );
      const steps = specs.slice(1).map((spec, k): Step => {
        const i = k + 1;
        const d = details[i]!;
        const base = { id: ids[i]!, key: keys[i]!, name: `Step ${i}`, ...(spec.loop === undefined ? {} : { loopId: ids[spec.loop]! }) };
        switch (spec.kind) {
          case "agent":
            return { ...base, type: "agent", agentId: "a1", prompt: prompt(i) };
          case "condition":
            return { ...base, type: "condition", value: d.value && refOf(d.value), op: d.op, operand: d.operand };
          case "data":
            return { ...base, type: "data", action: "create-row", tableId: "t1", inputs: [] };
          case "tool": {
            const inputs = d.inputs.map(([param, s]) => ({ param, source: typeof s === "string" ? { type: "value" as const, value: s } : refOf(s) }));
            return { ...base, type: "tool", toolId: "tool1", action: "act", inputs };
          }
          default: {
            const sources = specs.flatMap((s, j) => (j < i && s.loop === undefined && ["agent", "data", "tool"].includes(s.kind) ? [j] : []));
            if (trigger !== "schedule") sources.unshift(0);
            const from = sources[d.list % Math.max(1, sources.length)];
            if (from !== undefined && !edges.some((e) => e.from === ids[from] && e.to === ids[i])) edges.push({ from: ids[from]!, to: ids[i]! });
            return { ...base, type: "loop", list: from === undefined ? null : refOf([from, "list"]), maxIterations: d.max };
          }
        }
      });
      const field = { id: ids[0]!, key: keys[0]!, label: "Start" };
      const head: WorkflowDef["trigger"] =
        trigger === "schedule"
          ? { type: "schedule", field: { ...field, type: "schedule", cron: "0 9 * * *", timezone: "UTC" } }
          : { type: "manual", field: trigger === "chat" ? { ...field, type: "chat", agentId: "a1", prompt: prompt(0) } : { ...field, type: "button" } };
      return { trigger: head, steps, edges };
    });
});

const at = (steps: StepState[], nodeId: string, iteration: number) => steps.find((s) => s.nodeId === nodeId && s.iteration === iteration);
const named = (acts: Action[]) => acts.filter((a): a is Extract<Action, { nodeId: string }> => "nodeId" in a);
const isLoop = (def: WorkflowDef, id: string) => def.steps.some((s) => s.id === id && s.type === "loop");
const topNodes = (def: WorkflowDef) => nodesOf(def).filter((n) => n.loopId === undefined);
/** The items of `loop`'s list, from its source's top-level row; undefined when it isn't a JSON array (loop.ts). */
const listItems = (c: Case, loop: LoopStep) => {
  const outputs = loop.list && at(c.steps, loop.list.nodeId, 0)?.outputs;
  const list = parseList(outputs && Object.hasOwn(outputs, loop.list!.name) ? outputs[loop.list!.name]! : "");
  return "items" in list ? list.items : undefined;
};
const loopNamed = (def: WorkflowDef, id: string | undefined) => def.steps.find((s): s is LoopStep => s.id === id && s.type === "loop");

const statuses = fc.oneof(
  { arbitrary: fc.constant<Status>("pending"), weight: 3 },
  { arbitrary: fc.constant<Status>("succeeded"), weight: 3 },
  { arbitrary: fc.constant<Status>("skipped"), weight: 2 },
  { arbitrary: fc.constantFrom<Status>("running", "waiting", "failed"), weight: 2 },
);
/** A row of `nodeId`; when it succeeded, what it gave: a condition its `matched`, a loop its results, others `outputs`. */
const rowOf = (def: WorkflowDef, nodeId: string, iteration: number) => {
  const type = def.steps.find((s) => s.id === nodeId)?.type;
  // A loop leans to running, so that its body has rows.
  const status = type === "loop" ? fc.oneof({ arbitrary: fc.constant<Status>("running"), weight: 2 }, statuses) : statuses;
  return fc.tuple(status, outputs, fc.boolean()).map(([status, out, matched]): StepState => {
    const given: Record<string, string> = type === "condition" ? { matched: String(matched) } : type === "loop" ? { count: "0", results: "[]" } : out;
    return { nodeId, iteration, status, outputs: status === "succeeded" ? given : null };
  });
};

/**
 * Rows as the engine keeps them: one per top-level node; a loop that started has its body's rows,
 * all of them per iteration, from 1, never more iterations than its list has items.
 */
const states = (def: WorkflowDef) => {
  const top = nodesOf(def).filter((n) => n.loopId === undefined);
  const loops = def.steps.filter((s) => s.type === "loop");
  const body = (loopId: string) => def.steps.filter((s) => s.loopId === loopId);
  return fc
    .record({
      top: fc.tuple(...top.map((n) => rowOf(def, n.id, 0))),
      bodies: fc.tuple(...loops.map((l) => fc.array(fc.tuple(...body(l.id).map((s) => rowOf(def, s.id, 0))), { maxLength: 3 }))),
    })
    .map(({ top, bodies }) => {
      const rows: StepState[] = [...top];
      loops.forEach((loop, k) => {
        if (!["running", "succeeded", "failed"].includes(at(rows, loop.id, 0)!.status)) return;
        const source = loop.list && at(rows, loop.list.nodeId, 0);
        const list = source?.status === "succeeded" ? parseList(source.outputs!.list ?? "") : { error: true };
        const iterations = bodies[k]!.slice(0, "items" in list ? list.items.length : undefined);
        rows.push(...iterations.flatMap((it, i) => it.map((r) => ({ ...r, iteration: i + 1 }))));
      });
      return rows;
    });
};

/** A definition with an `outputs` per node and the pauses `drive` takes. */
const runs = defs.chain((def) =>
  fc.record({
    def: fc.constant(def),
    outs: fc.array(outputs, { minLength: nodesOf(def).length, maxLength: nodesOf(def).length }),
    pauses: fc.array(fc.boolean(), { maxLength: 20 }),
  }),
);
/** Random rows, or the rows of a driven run stopped after a few passes. */
const cases: fc.Arbitrary<Case> = fc.oneof(
  defs.chain((def) => fc.tuple(states(def), firing).map(([steps, trigger]) => ({ def, steps, trigger }))),
  fc.tuple(runs, fc.nat({ max: 12 })).map(([run, rounds]) => {
    const { steps, trigger } = drive(run, rounds);
    return { def: run.def, steps, trigger };
  }),
);

/** The links into `nodeId` with their source's row in `iteration` (a body's links stay inside its loop). */
const incoming = (c: Case, nodeId: string, iteration: number) =>
  c.def.edges.filter((e) => e.to === nodeId).map((edge) => ({ edge, source: at(c.steps, edge.from, iteration) }));
type Link = ReturnType<typeof incoming>[number];
// next-actions.ts "live when its source succeeded and the edge is on the branch the source took (or on none) ... waiting otherwise".
const waiting = ({ source }: Link) => !DONE.includes(source?.status ?? "pending");
const live = ({ edge, source }: Link) =>
  source?.status === "succeeded" && (edge.branch === undefined || source.outputs?.matched === String(edge.branch === "then"));

/** What `nextActions` must give on any rows, each with the sentence it encodes. */
const rules: [string, (c: Case, acts: Action[]) => void][] = [
  [
    // next-actions.ts "a pending node whose incoming edges are all decided runs"; "or the loop completes after the last".
    "acts only on pending rows, but for a running loop's own complete or fail",
    (c, acts) => {
      for (const a of named(acts)) {
        const status = at(c.steps, a.nodeId, a.iteration)?.status;
        const loopEnd = isLoop(c.def, a.nodeId) && a.iteration === 0 && status === "running" && (a.type === "complete" || a.type === "fail");
        expect(status === "pending" || loopEnd, `${a.type} ${a.nodeId}@${a.iteration} (${status})`).toBe(true);
      }
    },
  ],
  [
    // next-actions.ts "runs when one of them is live ... and is skipped when none is".
    "gives a node at most one action per iteration, never both a start and a skip",
    (_, acts) => {
      const keys = named(acts).map((a) => `${a.nodeId}@${a.iteration}`);
      expect(new Set(keys).size).toBe(keys.length);
    },
  ],
  [
    // next-actions.ts "a pending node whose incoming edges are all decided runs".
    "never acts on a pending node with a waiting incoming edge",
    (c, acts) => {
      for (const a of named(acts))
        if (at(c.steps, a.nodeId, a.iteration)?.status === "pending") expect(incoming(c, a.nodeId, a.iteration).some(waiting)).toBe(false);
    },
  ],
  [
    // next-actions.ts "runs when one of them is live (so a join runs once, after all its branches) and is skipped when none is".
    "acts once on each ready top-level node, a skip exactly when none of its incoming edges is live",
    (c, acts) => {
      for (const n of topNodes(c.def)) {
        const into = incoming(c, n.id, 0);
        if (at(c.steps, n.id, 0)?.status !== "pending" || into.some(waiting)) continue;
        const mine = named(acts).filter((a) => a.nodeId === n.id && a.iteration === 0);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.type === "skip").toBe(into.length > 0 && !into.some(live));
      }
    },
  ],
  [
    // next-actions.ts "Every top-level node succeeded or skipped finishes the run."
    "finishes exactly when every top-level node succeeded or skipped, and then does nothing else",
    (c, acts) => {
      const done = topNodes(c.def).every((n) => DONE.includes(at(c.steps, n.id, 0)?.status ?? "pending"));
      expect(acts.some((a) => a.type === "finish")).toBe(done);
      if (done) expect(acts).toEqual([{ type: "finish", status: "succeeded" }]);
    },
  ],
  [
    // next-actions.ts "A ready button, schedule trigger ... or condition completes here; a data or Tool step runs in the engine; a loop ... opens its first iteration; any other ready node starts a session."
    "acts on a ready node as its type says",
    (c, acts) => {
      const types = new Map(nodesOf(c.def).map((n) => [n.id, n.type]));
      for (const a of named(acts)) {
        if (at(c.steps, a.nodeId, a.iteration)?.status !== "pending" || a.type === "skip") continue;
        const type = types.get(a.nodeId)!;
        const done = a.type === "complete" ? a.outputs : null;
        // "A button gives nothing; a Job's button-shaped trigger node, its event's change."
        if (type === "button") expect(done).toEqual(c.trigger?.outputs ?? {});
        // "(with `scheduled_for`, from `trigger`)", in the schedule's timezone (UTC here).
        else if (type === "schedule") expect(done).toEqual(c.trigger ? { scheduled_for: "2026-01-01T09:00:00+00:00" } : {});
        // model.ts "it gives `matched` ("true" or "false")".
        else if (type === "condition") expect(a.type === "fail" || ["true", "false"].includes(done?.matched ?? "")).toBe(true);
        else if (type === "loop") {
          // "a loop checks its list": a JSON array (loop.ts) of at most `maxIterations` items (en.json loopTooMany "this loop runs at most").
          const loop = loopNamed(c.def, a.nodeId)!;
          const items = listItems(c, loop);
          const opens = acts.some((o) => o.type === "open-iteration" && o.loopId === a.nodeId && o.iteration === 1);
          if (items === undefined || items.length > loop.maxIterations) expect(a.type).toBe("fail");
          else if (items.length === 0) expect(done).toEqual({ count: "0", results: "[]" });
          else expect([a.type, opens]).toEqual(["start", true]);
        } else expect(a.type).toBe(type === "data" || type === "tool" ? type : "start");
      }
    },
  ],
  [
    // next-actions.ts "once it is done, the next iteration opens, or the loop completes after the last"; model.ts "one iteration after another".
    "opens a loop's iterations one after another, its body acting in the last one only, and completes it after the last",
    (c, acts) => {
      for (const loop of c.def.steps.filter((s) => s.type === "loop")) {
        const members = c.def.steps.filter((s) => s.loopId === loop.id);
        const body = members.map((s) => s.id);
        const items = listItems(c, loop);
        const current = Math.max(0, ...c.steps.filter((s) => body.includes(s.nodeId)).map((s) => s.iteration));
        const done = current > 0 && body.every((id) => DONE.includes(at(c.steps, id, current)?.status ?? "pending"));
        const running = at(c.steps, loop.id, 0)?.status === "running";
        for (const a of acts) {
          if (a.type === "open-iteration" && a.loopId === loop.id) expect([a.iteration, current === 0 || done]).toEqual([current + 1, true]);
          if ("nodeId" in a && body.includes(a.nodeId)) expect([a.iteration, running]).toEqual([current, true]);
          // "A loop's items, from its list's value": a running loop fails only on a list that isn't one (or on
          // `results` past MAX_RESULTS, , which these few short outputs never reach).
          if ("nodeId" in a && a.nodeId === loop.id && running) expect(a.type === "fail").toBe(items === undefined);
          if (a.type === "complete" && a.nodeId === loop.id && running) {
            expect([done, current, a.outputs.count]).toEqual([true, items?.length, String(current)]);
            // loop.ts "one object per iteration, its succeeded body steps' outputs by key".
            const results = Array.from({ length: current }, (_, i) =>
              Object.fromEntries(
                members.flatMap((s) => {
                  const row = at(c.steps, s.id, i + 1);
                  return row?.status === "succeeded" ? [[s.key, row.outputs]] : [];
                }),
              ),
            );
            expect(JSON.parse(a.outputs.results!)).toEqual(results);
          }
        }
      }
    },
  ],
];

// Fixed seeds and few runs: the same inputs on every run, so a merge queue never meets a new one.
rules.forEach(([name, rule], i) => {
  test(`nextActions ${name}`, () => {
    fc.assert(
      fc.property(cases, (c) => rule(c, nextActions(c.def, c.steps, c.trigger))),
      { seed: 101 + i, numRuns: 200 },
    );
  });
});

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
};

/** Every node with each iteration it has a row in: what `valuesFor`, `outputsFor` and `toolValues` are asked about. */
const readers = (c: Case) =>
  nodesOf(c.def).flatMap((n) =>
    n.loopId === undefined ? [{ reader: n, iteration: 0 }] : c.steps.filter((s) => s.nodeId === n.id).map((s) => ({ reader: n, iteration: s.iteration })),
  );
/** The row of `n` that `reader` sees in `iteration`: top-level ones, and its own loop body's in that iteration (its loop gives the item instead). */
const seenRow = (c: Case, reader: WorkflowNode, iteration: number, n: WorkflowNode) =>
  n.id === reader.loopId ? undefined : n.loopId === undefined ? at(c.steps, n.id, 0) : n.loopId === reader.loopId ? at(c.steps, n.id, iteration) : undefined;

// next-actions.ts "Pure: what a run does next, from its definition and its steps as they are."
test("nextActions and the value readers are pure: frozen inputs, the same actions twice", () => {
  fc.assert(
    fc.property(cases, (c) => {
      freeze(c);
      const first = nextActions(c.def, c.steps, c.trigger);
      expect(nextActions(c.def, c.steps, c.trigger)).toEqual(first);
      for (const { reader, iteration } of readers(c)) {
        expect(valuesFor(c.def, c.steps, reader.id, iteration)).toEqual(valuesFor(c.def, c.steps, reader.id, iteration));
        expect(outputsFor(c.def, c.steps, reader.id, iteration)).toEqual(outputsFor(c.def, c.steps, reader.id, iteration));
        expect(toolValues(c.def, c.steps, reader.id, iteration)).toEqual(toolValues(c.def, c.steps, reader.id, iteration));
      }
    }),
    { seed: 201, numRuns: 150 },
  );
});

// next-actions.ts "every succeeded node's outputs it sees (... its loop body's in that iteration only), and `""` for each field it references on a skipped node"; "a key like `constructor` must not reach Object's".
test('valuesFor gives what a node sees by key, "" for each field it references on a skipped node, never through Object\'s', () => {
  const before = [Object.getOwnPropertyNames(Object.prototype), Object.getOwnPropertyNames(Object)];
  fc.assert(
    fc.property(cases, (c) => {
      const nodes = nodesOf(c.def);
      for (const { reader, iteration } of readers(c)) {
        const values = valuesFor(c.def, c.steps, reader.id, iteration);
        const expected = new Set<string>();
        const skipped = new Map<string, Set<string>>();
        for (const n of nodes) {
          const row = seenRow(c, reader, iteration, n);
          if (row?.status === "succeeded" && row.outputs) {
            expected.add(n.key);
            expect(Object.hasOwn(values, n.key) && values[n.key]).toEqual(row.outputs);
          }
          const fields = references(reader.prompt ?? "").flatMap((r) => (r.key === n.key ? [r.field] : []));
          if (row?.status === "skipped" && fields.length > 0) skipped.set(n.key, new Set(fields));
        }
        for (const [key, fields] of skipped) {
          expected.add(key);
          expect(Object.hasOwn(values, key) && Object.entries(values[key]!)).toEqual([...fields].map((f) => [f, ""]));
        }
        const loop = loopNamed(c.def, reader.loopId);
        if (loop) {
          expected.add(loop.key);
          // "the loop giving the item's values": this iteration's item, `index` from 1 (loop.ts).
          expect(Object.hasOwn(values, loop.key) && values[loop.key]).toEqual(itemValues(listItems(c, loop)?.[iteration - 1], iteration - 1));
        }
        expect(Object.keys(values).sort()).toEqual([...expected].sort());
      }
      expect([Object.getOwnPropertyNames(Object.prototype), Object.getOwnPropertyNames(Object)]).toEqual(before);
    }),
    { seed: 202, numRuns: 300 },
  );
});

// next-actions.ts "Each succeeded node's outputs `nodeId` sees in `iteration`, by node id".
test("outputsFor gives each succeeded node's outputs a node sees, by id, and nothing else", () => {
  fc.assert(
    fc.property(cases, (c) => {
      const nodes = nodesOf(c.def);
      for (const { reader, iteration } of readers(c)) {
        const got = outputsFor(c.def, c.steps, reader.id, iteration);
        const expected = new Set<string>();
        for (const n of nodes) {
          const row = seenRow(c, reader, iteration, n);
          if (row?.status !== "succeeded" || !row.outputs) continue;
          expected.add(n.id);
          expect(Object.hasOwn(got, n.id) && got[n.id]).toEqual(row.outputs);
        }
        const loop = loopNamed(c.def, reader.loopId);
        if (loop) {
          expected.add(loop.id);
          expect(Object.hasOwn(got, loop.id) && got[loop.id]).toEqual(itemValues(listItems(c, loop)?.[iteration - 1], iteration - 1));
        }
        expect(Object.keys(got).sort()).toEqual([...expected].sort());
      }
    }),
    { seed: 203, numRuns: 300 },
  );
});

// next-actions.ts "a literal as is, an upstream value ... (`""` when its node didn't give that field), or, when that node was skipped, its name".
test('toolValues gives each wired parameter its literal, its upstream value or "", or a skipped node\'s name', () => {
  fc.assert(
    fc.property(cases, (c) => {
      const nodes = nodesOf(c.def);
      for (const { reader, iteration } of readers(c)) {
        const step = c.def.steps.find((s) => s.id === reader.id);
        if (step?.type !== "tool") continue;
        const got = toolValues(c.def, c.steps, reader.id, iteration);
        expect([...got.keys()]).toEqual(step.inputs.map((i) => i.param));
        for (const { param, source } of step.inputs) {
          const n = source.type === "output" ? nodes.find((m) => m.id === source.nodeId)! : undefined;
          const row = n && seenRow(c, reader, iteration, n);
          if (source.type === "value") expect(got.get(param)).toBe(source.value);
          else if (row?.status === "skipped") expect(got.get(param)).toEqual({ skipped: n!.name });
          // loop.ts "`index` (from 1)": the one field of its loop this generator reads that the item gives.
          else if (source.nodeId === reader.loopId) expect(got.get(param)).toBe(source.name === "index" ? String(iteration) : "");
          else expect(got.get(param)).toBe(row?.outputs && Object.hasOwn(row.outputs, source.name) ? row.outputs[source.name] : "");
        }
      }
    }),
    { seed: 204, numRuns: 400 },
  );
});

// next-actions.ts "A ready ... condition completes here"; model.ts "it gives `matched`"; "dead when its source ... took the other branch".
test("a condition fails on its value's error or gives whether it matched, and then its branch runs and the other is skipped", () => {
  const value = fc.oneof(texts, fc.string({ maxLength: 4 }));
  fc.assert(
    fc.property(fc.constantFrom(...CONDITION_OPS), value, value, (op, given, operand) => {
      const def: WorkflowDef = {
        trigger: { type: "manual", field: { id: "n_chat", key: "chat", type: "chat", label: "Chat", agentId: "a1", prompt: "Ask." } },
        steps: [
          { id: "n_if", key: "if", type: "condition", name: "If", value: { type: "output", nodeId: "n_chat", name: "v" }, op, operand },
          { id: "n_t", key: "t", type: "agent", name: "T", agentId: "a1", prompt: "T." },
          { id: "n_e", key: "e", type: "agent", name: "E", agentId: "a1", prompt: "E." },
        ],
        edges: [
          { from: "n_chat", to: "n_if" },
          { from: "n_if", to: "n_t", branch: "then" },
          { from: "n_if", to: "n_e", branch: "else" },
        ],
      };
      const steps: StepState[] = [
        { nodeId: "n_chat", iteration: 0, status: "succeeded", outputs: { v: given } },
        ...["n_if", "n_t", "n_e"].map((nodeId) => ({ nodeId, iteration: 0, status: "pending" as const, outputs: null })),
      ];
      const result = evaluateCondition(op, given, operand);
      const decided = { nodeId: "n_if", iteration: 0 };
      if ("error" in result) {
        expect(nextActions(def, steps)).toEqual([{ type: "fail", ...decided, error: result.error }]);
        return;
      }
      expect(nextActions(def, steps)).toEqual([{ type: "complete", ...decided, outputs: { matched: String(result.matched) } }]);
      steps[1] = { ...steps[1]!, status: "succeeded", outputs: { matched: String(result.matched) } };
      const [taken, other] = result.matched ? ["n_t", "n_e"] : ["n_e", "n_t"];
      const next = nextActions(def, steps);
      expect(next).toHaveLength(2);
      expect(next).toContainEqual({ type: "start", nodeId: taken, iteration: 0 });
      expect(next).toContainEqual({ type: "skip", nodeId: other, iteration: 0 });
    }),
    { seed: 205, numRuns: 1_000 },
  );
});

/**
 * Applies a run's actions as `Engine.advance` does for `rounds` passes, or until it finishes or fails,
 * its firing giving the trigger's `outs`. A started session or Tool step stays running while the next
 * of `pauses` says so (each read once), then succeeds with its node's `outs`; `check` sees every pass.
 */
function drive(
  { def, outs, pauses }: { def: WorkflowDef; outs: Record<string, string>[]; pauses: boolean[] },
  rounds: number,
  check?: (c: Case, acts: Action[]) => void,
) {
  const trigger = { scheduledFor: WHEN, outputs: outs[0]! };
  const nodes = nodesOf(def);
  const steps: StepState[] = topNodes(def).map((n) => ({ nodeId: n.id, iteration: 0, status: "pending", outputs: null }));
  const opened = new Map<string, number[]>();
  const queue = [...pauses];
  const pause = () => queue.shift() ?? false;
  const succeed = (row: StepState) => Object.assign(row, { status: "succeeded", outputs: outs[nodes.findIndex((n) => n.id === row.nodeId)]! });
  const working = (row: StepState) => row.status === "running" && !isLoop(def, row.nodeId);
  for (let round = 0; round < rounds; round++) {
    for (const row of steps) if (working(row) && !pause()) succeed(row);
    const acts = nextActions(def, steps, trigger);
    check?.({ def, steps, trigger }, acts);
    if (acts.length === 0 && !steps.some(working)) return { end: "stuck" as const, steps, opened, trigger };
    for (const a of acts) {
      if (a.type === "finish" || a.type === "fail") return { end: a.type, steps, opened, trigger };
      if (a.type === "open-iteration") {
        opened.set(a.loopId, [...(opened.get(a.loopId) ?? []), a.iteration]);
        for (const s of def.steps) if (s.loopId === a.loopId) steps.push({ nodeId: s.id, iteration: a.iteration, status: "pending", outputs: null });
        continue;
      }
      const row = at(steps, a.nodeId, a.iteration)!;
      if (a.type === "skip") row.status = "skipped";
      else if (a.type === "complete") Object.assign(row, { status: "succeeded", outputs: a.outputs });
      else if (isLoop(def, a.nodeId) || (a.type !== "data" && pause())) row.status = "running";
      else succeed(row);
    }
  }
  return { end: "paused" as const, steps, opened, trigger };
}

// next-actions.ts "a pending node whose incoming edges are all decided runs ... Every top-level node succeeded or skipped finishes the run"; model.ts "runs its body ... once, one iteration after another".
test("a run driven by its own actions ends in finish or a failure, each loop opening one iteration per item, in order", () => {
  fc.assert(
    fc.property(runs, (run) => {
      const { end, steps, opened } = drive(run, 1_000, (c, acts) => rules.forEach(([, rule]) => rule(c, acts)));
      expect(["finish", "fail"]).toContain(end);
      for (const loop of run.def.steps.filter((s) => s.type === "loop")) {
        const row = at(steps, loop.id, 0)!;
        if (row.status !== "succeeded") continue;
        const list = parseList(at(steps, loop.list!.nodeId, 0)!.outputs!.list!);
        const count = "items" in list ? list.items.length : -1;
        expect([row.outputs!.count, opened.get(loop.id) ?? []]).toEqual([String(count), Array.from({ length: count }, (_, i) => i + 1)]);
      }
    }),
    { seed: 206, numRuns: 500 },
  );
});
