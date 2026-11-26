import { expect, test } from "vitest";
import * as domain from "./index.ts";
import { ANY_WORKSPACE } from "./engine/engine.ts";
import { EngineError } from "./engine/errors.ts";
import { onGrantEnd } from "./runners/grants.ts";
import { RunnerRequestFailed } from "./runners/hub.ts";

// A process that embeds Dispand rethrows an error under its own class, listens to grant ends and
// pings every workspace's questions: the package hands it the very objects Dispand itself uses.
test("index exports the errors, the grant-end hook and the any-workspace key", () => {
  expect(domain.EngineError).toBe(EngineError);
  expect(domain.RunnerRequestFailed).toBe(RunnerRequestFailed);
  expect(domain.onGrantEnd).toBe(onGrantEnd);
  expect(domain.ANY_WORKSPACE).toBe(ANY_WORKSPACE);
});
