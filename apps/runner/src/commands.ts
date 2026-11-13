import { skillCommands } from "./codex/skills.ts";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessCommands, type HarnessCommand, type PluginReport } from "@dispand/runner-protocol";
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


/** Only an unambiguous, verified native installation can bind a command to workspace files. */
export function commandSources(commands: HarnessCommand[], harness: "codex" | "claude-code", report: PluginReport): HarnessCommand[] {
  return commands.map((command) => {
    const safe = { ...command };
    delete safe.sourceKey;
    if (report.error) return safe;
    const namespace = harness === "codex" ? command.nativeNamespace : command.name.includes(":") ? command.name.slice(0, command.name.indexOf(":")) : undefined;
    const matching = report.packages?.filter((p) => p.namespace === namespace && namespace !== undefined && p.harness === harness && p.installed && p.enabled === true && !p.pending && p.sourceKey) ?? [];
    return matching.length === 1 ? { ...safe, sourceKey: matching[0]!.sourceKey! } : safe;
  });
}
