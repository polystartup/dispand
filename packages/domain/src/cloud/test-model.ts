// Test support: a scripted model for cloud sessions.
import type { ClientHarness, ModelTurn, TurnInput } from "./model-client.ts";

export type Script = (input: TurnInput) => Partial<ModelTurn> | Promise<Partial<ModelTurn>>;

/** A model that answers each call with the next scripted turn, and keeps what it was sent. */
export function fakeModel(...script: Script[]) {
  const inputs: TurnInput[] = [];
  const harnesses: ClientHarness[] = [];
  const client = (h: ClientHarness) => {
    harnesses.push(h);
    return {
      async turn(input: TurnInput): Promise<ModelTurn> {
        inputs.push({ ...input, items: structuredClone(input.items) });
        const next = script.shift();
        if (!next) throw Object.assign(new Error("no turn left"), { status: 500 });
        const t = await next(input);
        if (t.text) input.onText(t.text);
        const toolCalls = t.toolCalls ?? [];
        return { text: t.text ?? "", toolCalls, raw: { fake: true }, stop: t.stop ?? (toolCalls.length > 0 ? "tool_use" : "end") };
      },
    };
  };
  return { client, inputs, harnesses };
}

export const say = (text: string): Script => () => ({ text });
export const use = (name: string, args: unknown, id = `call_${name}`): Script => () => ({ toolCalls: [{ id, name, args }] });
