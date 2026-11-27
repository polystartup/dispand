// The sandbox tests (`DISPAND_SANDBOX_IMAGE` set): Claude Code installed into their state folder
// (`state.ts`) as the supervisor's first start does, before any worker starts, so each worker
// gets it bound read-only.
import { installClaudeCode } from "../../src/claude-code.ts";
import { localState } from "./state.ts";

export default async function setup() {
  if (!process.env.DISPAND_SANDBOX_IMAGE) return;
  const root = process.env.DISPAND_SANDBOX_STATE ?? (await localState());
  console.log(`Claude Code: ${await installClaudeCode(root, "clis/claude-code")} in ${root}`);
}
