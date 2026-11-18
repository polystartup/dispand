import type { RecordResult } from "../messages/record-result.ts";

// Only the in-process platform caller mints these capabilities. JSON from MCP/native tools
// cannot impersonate them by returning the same key, name, or result-shaped properties.
const specs = new WeakSet<object>();
const results = new WeakMap<object, RecordResult>();

export function recordToolSpec<T extends object>(spec: T): T {
  specs.add(spec);
  return spec;
}

export function isRecordTool(spec: object | undefined): boolean {
  return spec !== undefined && specs.has(spec);
}

export function withRecordResult<T extends object>(outcome: T, record: RecordResult): T {
  results.set(outcome, record);
  return outcome;
}

export function recordResultOf(outcome: object): RecordResult | undefined {
  return results.get(outcome);
}
