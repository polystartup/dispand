import { createAnthropicClient } from "../cloud/anthropic.ts";
import type { ClientHarness, ModelClient, ToolCall, TurnInput } from "../cloud/model-client.ts";

// The behaviour evals' model client: the product's own Anthropic client, with the key from the
// environment only, behind a hard budget, and a record of what each case's model was given and did.

/** US dollars per million tokens, as the provider lists them. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/**
 * Input is priced as a cache write (1.25 times): the client counts cache reads and writes as input,
 * and asks for caching, so every cost here is an upper bound.
 */
const INPUT_RATE = 1.25;

export type Settings = {
  model: string;
  key: string;
  /** The run stops before a call that could take it past either ceiling. */
  maxUsd: number;
  maxTokens: number;
  /** The most a call may write, and the most calls one case may make. */
  maxOutput: number;
  maxCalls: number;
  /** How many times each case runs. */
  repeat: number;
};

const number = (value: string | undefined, fallback: number) => (value === undefined || value === "" ? fallback : Number(value));

/** The settings from the environment, or why the evals can't run. Never the key itself in a message. */
export function settings(env: NodeJS.ProcessEnv = process.env): Settings | { problem: string } {
  // A small model by default: what a run costs most. The evidence a decision needs comes from the model its harnesses use.
  const model = env.DISPAND_EVAL_MODEL || "claude-haiku-5-5";
  if (!PRICES[model]) return { problem: `No price for ${model}: use one of ${Object.keys(PRICES).join(", ")}.` };
  if (!env.ANTHROPIC_API_KEY) return { problem: "ANTHROPIC_API_KEY is not set." };
  const s = {
    model,
    key: env.ANTHROPIC_API_KEY,
    maxUsd: number(env.DISPAND_EVAL_MAX_USD, 3),
    maxTokens: number(env.DISPAND_EVAL_MAX_TOKENS, 1_500_000),
    maxOutput: 8192,
    maxCalls: 16,
    repeat: number(env.DISPAND_EVAL_REPEAT, 3),
  };
  const bad = (["maxUsd", "maxTokens", "repeat"] as const).find((k) => !(s[k] > 0));
  return bad ? { problem: `${bad} must be a positive number.` } : s;
}

/** Why a call was refused: it would pass a ceiling. Not transient, so the cloud loop fails the step at once. */
export class OverBudget extends Error {}

/** What one case's model was given and did, across its calls. */
export type Seen = {
  calls: number;
  input: number;
  output: number;
  /** Every tool the model was offered, by name. */
  offered: Set<string>;
  /** Every tool call it made, in order. */
  toolCalls: ToolCall[];
  /** Everything it was given (system prompts, messages, tool results) and wrote, as text. */
  given: string[];
  written: string[];
  /** The last call ended with no tool call: the agent finished its turn. */
  done: boolean;
  /** A call was refused: the run's budget is spent. */
  overBudget: boolean;
  /** The calls the provider refused or failed, by error name and status: never its message, which may echo the key. */
  errors: string[];
};

const seen = (): Seen => ({
  calls: 0,
  input: 0,
  output: 0,
  offered: new Set(),
  toolCalls: [],
  given: [],
  written: [],
  done: false,
  overBudget: false,
  errors: [],
});

/** An error's name and status, which say what failed without its message. */
const errorOf = (err: unknown) => {
  const { name, status } = (err ?? {}) as { name?: unknown; status?: unknown };
  return [typeof name === "string" ? name : "Error", typeof status === "number" ? status : ""].join(" ").trim();
};

/** The run's spend across cases, and the case being recorded. */
export class Meter {
  input = 0;
  output = 0;
  case: Seen = seen();
  /** Set when the provider refused the key: no later call can succeed. */
  fatal: string | null = null;
  private readonly price: { input: number; output: number };

  constructor(readonly s: Settings) {
    this.price = PRICES[s.model]!;
  }

  cost(input = this.input, output = this.output): number {
    return (input * this.price.input * INPUT_RATE + output * this.price.output) / 1e6;
  }

  /** Starts recording a new case. */
  begin(): Seen {
    this.case = seen();
    return this.case;
  }

  /** Whether the run has room for one more call as large as the case's last one may be. */
  room(): boolean {
    // Its input as large as the case's last call's, or a first call's that carries the Assistant's tools.
    const input = Math.max(this.case.calls ? this.case.input / this.case.calls : 0, 40_000) * 1.5;
    return (
      this.case.calls < this.s.maxCalls &&
      this.input + this.output + input + this.s.maxOutput <= this.s.maxTokens &&
      this.cost(this.input + input, this.output + this.s.maxOutput) <= this.s.maxUsd
    );
  }

  /** A model client for the cloud loop: the harness as configured, but the eval's model, key and output bound. */
  client = (h: ClientHarness): ModelClient => {
    const inner = createAnthropicClient(
      { ...h, kind: "anthropic", baseUrl: undefined, model: this.s.model, apiKey: this.s.key, maxTokens: this.s.maxOutput },
      {},
    );
    return {
      turn: async (input: TurnInput) => {
        const c = this.case;
        if (!this.room()) {
          c.overBudget = true;
          throw new OverBudget("The eval's budget is spent.");
        }
        c.calls++;
        for (const t of input.tools) c.offered.add(t.name);
        c.given.push(input.system, ...input.items.map((i) => (i.role === "tool" ? i.result : i.text)));
        if (this.fatal) throw new OverBudget(this.fatal);
        const turn = await inner.turn(input).catch((err: unknown) => {
          const what = errorOf(err);
          c.errors.push(what);
          if (/ 40[13]$/.test(what)) this.fatal = `the provider refused the key (${what})`;
          throw err;
        });
        this.input += turn.usage?.input ?? 0;
        this.output += turn.usage?.output ?? 0;
        c.input += turn.usage?.input ?? 0;
        c.output += turn.usage?.output ?? 0;
        c.toolCalls.push(...turn.toolCalls);
        c.written.push(turn.text, ...turn.toolCalls.map((t) => JSON.stringify(t.args)));
        c.done = turn.toolCalls.length === 0;
        return turn;
      },
    };
  };
}
