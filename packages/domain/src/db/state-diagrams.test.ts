import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CLOUD_SESSION_STATUSES, STEP_STATUSES, TURN_STATUSES } from "./schema.ts";

// The state diagrams of `docs/architecture/diagrams.md` name exactly the states their types have.
// A state diagram's heading ends with the type it draws, in backticks and brackets.

const doc = readFileSync(join(import.meta.dirname, "../../../../docs/architecture/diagrams.md"), "utf8").replaceAll("\r\n", "\n");
/** Each type's states: the list `db/schema.ts` derives it from. */
const members: Record<string, readonly string[]> = { StepStatus: STEP_STATUSES, TurnStatus: TURN_STATUSES, CloudSessionStatus: CLOUD_SESSION_STATUSES };

/** Each state diagram under a heading naming its type: the states its transitions name. */
const diagrams = new Map(
  [...doc.matchAll(/\(`(\w+)`\)\n(?:(?!\n#)[\s\S])*?```mermaid\nstateDiagram-v2\n([\s\S]*?)```/g)].map(([, name, body]) => {
    const states = body!
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        const transition = /^\s*(\[\*\]|\w+) --> (\[\*\]|\w+)(?: : .*)?$/.exec(line);
        if (!transition) throw new Error(`${name}: not a transition: ${line}`);
        return [transition[1]!, transition[2]!].filter((state) => state !== "[*]");
      });
    return [name!, [...new Set(states)]];
  }),
);

test("every state diagram is checked against its type", () => {
  expect([...diagrams.keys()]).toEqual(["StepStatus", "TurnStatus", "CloudSessionStatus"]);
  expect(doc.match(/^stateDiagram/gm)).toHaveLength(diagrams.size);
});

test.each(["StepStatus", "TurnStatus", "CloudSessionStatus"])("the %s diagram names its type's states, all of them and no other", (name) => {
  expect(diagrams.get(name)?.toSorted()).toEqual(members[name]!.toSorted());
});
