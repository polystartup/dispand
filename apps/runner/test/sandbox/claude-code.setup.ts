// The sandbox tests in the supervisor image (CI's runner-sandbox job): Claude Code installed into
// the state volume as the supervisor's first start does, before any worker starts, so each
// worker gets it bound read-only. Elsewhere (a temporary state folder per test, no install),
// workers have no Claude Code.
import { installClaudeCode } from "../../src/claude-code.ts";

export default async function setup() {
  const root = process.env.DISPAND_SANDBOX_STATE;
  if (root) console.log(`Claude Code: ${await installClaudeCode(root, "clis/claude-code")} in ${root}`);
}
