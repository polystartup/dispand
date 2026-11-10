import { OutputField, TEXT } from "@dispand/runner-protocol";
import { storableText } from "../text.ts";
import type { ToolAction, ToolResult } from "./mcp.ts";

// Pure: the workflow model checks Tool steps with it, and the web editor imports that.

/** The JSON types a parameter is coerced to; anything else is sent as text. */
export type ParamType = "string" | "number" | "integer" | "boolean" | "array" | "object";

/** One top-level parameter of an action, from its input schema. */
export type ActionParam = { name: string; type: ParamType; description: string; required: boolean };

/** The longest error text an `isError` result passes on. */
export const MAX_TOOL_ERROR = 500;

const TYPES: readonly string[] = ["string", "number", "integer", "boolean", "array", "object"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The schema's `type`, or the first non-null one of a list; text when it names none we coerce to. */
function typeOf(schema: unknown): ParamType {
  const type: unknown = isObject(schema) ? schema.type : undefined;
  const named = Array.isArray(type) ? type.find((t) => t !== "null") : type;
  return typeof named === "string" && TYPES.includes(named) ? (named as ParamType) : "string";
}

/** The action's top-level parameters (`inputSchema.properties`), in the schema's order. */
export function actionParams(action: Pick<ToolAction, "inputSchema">): ActionParam[] {
  const { properties, required } = action.inputSchema;
  if (!isObject(properties)) return [];
  const needed = new Set(Array.isArray(required) ? required.filter((r) => typeof r === "string") : []);
  return Object.entries(properties).map(([name, schema]) => {
    const description = isObject(schema) && typeof schema.description === "string" ? schema.description : "";
    return { name, type: typeOf(schema), description, required: needed.has(name) };
  });
}

/** The top-level fields of the action's structured result, when it declares them (`outputSchema.properties`). */
export function actionOutputFields(action: Pick<ToolAction, "outputSchema">): string[] | null {
  const properties = action.outputSchema?.properties;
  return isObject(properties) ? Object.keys(properties) : null;
}

/** What a value for `type` looks like, for the agent asked to give it; null for text. */
export function typeHint(type: ParamType): string | null {
  return { string: null, number: "a number", integer: "a whole number", boolean: "true or false", array: "a JSON array", object: "a JSON object" }[type];
}

/** `value` as `type`, or why it isn't one ("“p” must be …" follows from it). */
export function coerceValue(type: ParamType, value: string): { value: unknown } | { error: string } {
  switch (type) {
    case "string":
      return { value };
    case "number":
    case "integer": {
      const n = value.trim() === "" ? NaN : Number(value);
      if (!Number.isFinite(n)) return { error: "must be a number" };
      if (type === "integer" && !Number.isInteger(n)) return { error: "must be a whole number" };
      return { value: n };
    }
    case "boolean": {
      const v = value.trim().toLowerCase();
      return v === "true" ? { value: true } : v === "false" ? { value: false } : { error: "must be true or false" };
    }
    case "array":
    case "object": {
      const shape = type === "array" ? "an array" : "an object";
      try {
        const parsed: unknown = JSON.parse(value);
        if (type === "array" ? Array.isArray(parsed) : isObject(parsed)) return { value: parsed };
      } catch {
        // Not JSON: the same error as the wrong shape.
      }
      return { error: `must be JSON (${shape})` };
    }
  }
}

/**
 * What a parameter gets at run time: its text, or the name of the step its value comes from when
 * that step was skipped (so it has none). An unwired parameter has no entry.
 */
export type ArgValue = string | { skipped: string };

/**
 * The call's arguments, each coerced to its parameter's type. A parameter without a value (not
 * wired, its step skipped, or `""` for anything but text) is left out, unless it is required: then
 * the call doesn't go out. Values for names the schema doesn't have are dropped.
 */
export function coerceArguments(action: Pick<ToolAction, "inputSchema">, values: Map<string, ArgValue>): { args: Record<string, unknown> } | { error: string } {
  const args: [string, unknown][] = [];
  for (const param of actionParams(action)) {
    const value = values.get(param.name);
    const empty = value === undefined || typeof value === "object" || (param.type !== "string" && value.trim() === "");
    if (empty) {
      if (!param.required) continue;
      const skipped = typeof value === "object" ? ` (“${value.skipped}” was skipped)` : "";
      return { error: `“${param.name}” has no value${skipped}` };
    }
    const coerced = coerceValue(param.type, value);
    if ("error" in coerced) return { error: `“${param.name}” ${coerced.error}` };
    args.push([param.name, coerced.value]);
  }
  // `fromEntries` defines own properties: a parameter named `__proto__` stays one.
  return { args: Object.fromEntries(args) };
}

/** `text` cut to the protocol's `TEXT` (what a prompt holds at most), storable. */
const fit = (text: string) => storableText(text.length > TEXT ? `${text.slice(0, TEXT - 12)}\n[truncated]` : text);

/**
 * What a Tool step gives the steps after it: `result`, the result's text, and each top-level field
 * of its structured result (or, without one, of its text when that is a JSON object) whose name
 * can name a value: text as is, anything else as JSON (so a list feeds a loop).
 */
export function toolOutputs(result: Pick<ToolResult, "text" | "structured">): Record<string, string> {
  let fields = result.structured;
  if (fields === undefined) {
    try {
      const parsed: unknown = JSON.parse(result.text);
      if (isObject(parsed)) fields = parsed;
    } catch {
      // Plain text: `result` only.
    }
  }
  const outputs: [string, string][] = [["result", fit(result.text)]];
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (name === "result" || !OutputField.shape.name.safeParse(name).success) continue;
    outputs.push([name, fit(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))]);
  }
  return Object.fromEntries(outputs);
}

/** Why an `isError` result fails its step: its first characters. */
export function toolErrorText(text: string): string {
  const head = text.trim().slice(0, MAX_TOOL_ERROR);
  return head ? `The tool answered with an error: ${storableText(head)}` : "The tool answered with an error";
}
