import { describe, expect, test } from "vitest";
import { askDescription, askRequest, offersAsk, renderAskText } from "./ask.ts";

const agent = { kind: "agent" as const, id: "agt_arch", name: "Architect", description: "Owns the schema.\nAsk it first." };
const person = { kind: "person" as const, id: "usr_ann", name: "Ann", description: "Sales, EU." };

describe("ask", () => {
  test("renders the questions one per line, each with its options and whether to pick one or several", () => {
    expect(
      renderAskText([
        { question: "Which region?", header: "", options: [{ label: "EU", description: "Europe" }, { label: "US" }], multiSelect: false },
        { question: "Which days?", header: "", options: [{ label: "Mon" }, { label: "Tue" }], multiSelect: true },
        { question: "Anything else?", header: "", options: [], multiSelect: false },
      ]),
    ).toBe("Which region?\nPick one of:\n- EU (Europe)\n- US\n\nWhich days?\nPick one or several of:\n- Mon\n- Tue\n\nAnything else?");
  });

  test("an ask to an agent is a consult carrying the rendered text; to a person, a choice naming them", () => {
    const start = { askTargets: [agent, person] };
    expect(askRequest({ to: "agt_arch", questions: [{ question: " Why? " }] }, start)).toEqual({
      kind: "consult",
      target: agent,
      payload: { kind: "consult", agentId: "agt_arch", question: "Why?" },
    });
    expect(askRequest({ to: "usr_ann", questions: [{ question: "Which?", options: [{ label: "A" }], multiSelect: true }] }, start)).toEqual({
      kind: "choice",
      to: "usr_ann",
      questions: [{ question: "Which?", header: "", options: [{ label: "A" }], multiSelect: true }],
    });
  });

  test("someone not listed, no question, or nobody named without escalation is refused; with escalation nobody named is a choice", () => {
    const start = { askTargets: [agent] };
    expect(askRequest({ to: "agt_other", questions: [{ question: "Hi?" }] }, start)).toHaveProperty("error");
    expect(askRequest({ to: "agt_arch", questions: [] }, start)).toHaveProperty("error");
    expect(askRequest({ to: "agt_arch", questions: [{ question: " " }] }, start)).toHaveProperty("error");
    expect(askRequest({ questions: [{ question: "Hi?" }] }, start)).toHaveProperty("error");
    expect(askRequest({ questions: [{ question: "Hi?" }] }, { ...start, escalate: true })).toEqual({
      kind: "choice",
      questions: [{ question: "Hi?", header: "", options: [], multiSelect: false }],
    });
  });

  test("is offered with someone listed or escalation on, never to a restricted session", () => {
    expect(offersAsk({})).toBe(false);
    expect(offersAsk({ askTargets: [agent] })).toBe(true);
    expect(offersAsk({ askTargets: [], escalate: true })).toBe(true);
    expect(offersAsk({ askTargets: [agent], escalate: true, restricted: true })).toBe(false);
  });

  test("lists agents and people in two groups, a person's words quoted, and the preference line only from preferAgents", () => {
    const off = askDescription({ askTargets: [agent, person], escalate: true });
    expect(off).toContain("- agt_arch: Architect — Owns the schema. Ask it first.");
    expect(off).toContain('- usr_ann: Ann — they wrote about themselves: "Sales, EU."');
    expect(off).not.toContain("Ask an agent unless");
    // The order of the list says nothing: only the flag writes the line.
    expect(askDescription({ askTargets: [agent, person], escalate: true, preferAgents: true })).toContain("Ask an agent unless none of them can answer.");
  });
});
