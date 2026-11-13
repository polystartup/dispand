import { skillCommands } from "./codex/skills.ts";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessCommands } from "@dispand/runner-protocol";
import type { SkillsListResponse } from "./codex/protocol/v2/SkillsListResponse.ts";
import { CodexRpc } from "./codex/rpc.ts";

/** CLI catalog discovery without sending a prompt or starting a model turn. */
export async function discoverCommands(harness: "codex" | "claude-code", path: string | undefined, env: NodeJS.ProcessEnv, cwd: string) {
  if (!path) throw new Error("CLI unavailable");
  if (harness === "codex") {
    const rpc = await CodexRpc.spawn(path, env, cwd, AbortSignal.timeout(20_000));
    try {
      const list: SkillsListResponse = await rpc.request("skills/list", { cwds: [cwd], forceReload: true });
      return HarnessCommands.parse(skillCommands(list.data.flatMap((entry) => entry.skills)));
    } finally { await rpc.close(); }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield* [];
  }
  const session = query({ prompt: input(), options: { pathToClaudeCodeExecutable: path, env, cwd, abortController: controller, persistSession: false } });
  try { return HarnessCommands.parse(await session.supportedCommands()); }
  finally { controller.abort(); clearTimeout(timer); session.close(); }
}
