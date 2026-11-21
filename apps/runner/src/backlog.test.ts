import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_NOT_RUNNING } from "@dispand/runner-protocol";
import { expect, onTestFinished, test } from "vitest";
import { BacklogFile } from "./backlog.ts";

test("an error written before failures had a kind is read back with its kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "backlog.jsonl");
  const event = (seq: number, message: string) => JSON.stringify({ type: "event", seq, sessionId: "ses_1", event: { type: "error", message } });
  writeFileSync(path, `${event(1, SESSION_NOT_RUNNING.message)}\n${event(2, "boom")}\n`);
  const file = new BacklogFile(path, { bytes: () => 0, raws: () => [] });
  onTestFinished(() => file.close());
  expect(file.load().map((e) => e.event)).toEqual([SESSION_NOT_RUNNING, { type: "error", message: "boom" }]);
});
