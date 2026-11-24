import { expect, test } from "vitest";
import { cliSummary } from "./RunnerSheet.tsx";

const t = ((key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`) as never;
const runner = (clis: Record<string, unknown>) => ({ clis, lastSeenAt: new Date().toISOString() }) as never;

test("a runner whose workers use its own OpenAI key is shown with that key, never as signed in", () => {
  expect(cliSummary(t, runner({ codex: { version: "0.169.0", signedIn: false }, modelKeys: ["openai"] }))).toBe('runners.codexKey{"version":"0.169.0"}');
  expect(cliSummary(t, runner({ codex: { version: "0.169.0", signedIn: false } }))).toBe('runners.codexSignedOut{"version":"0.169.0"}');
  expect(cliSummary(t, runner({ codex: { version: "0.169.0", signedIn: true } }))).toBe('runners.codex{"version":"0.169.0"}');
});
