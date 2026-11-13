import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { HarnessModels } from "@dispand/runner-protocol";
import { tmpdir } from "node:os";
import type { ModelListResponse } from "./codex/protocol/v2/ModelListResponse.ts";
import { CodexRpc } from "./codex/rpc.ts";

/** Discover through the installed CLI without sending a prompt or starting a model turn. */
export async function discoverModels(harness: "codex" | "claude-code", path: string | undefined, env: NodeJS.ProcessEnv) {
  if (!path) throw new Error("CLI unavailable");
  if (harness === "codex") {
    const rpc = await CodexRpc.spawn(path, env, tmpdir(), AbortSignal.timeout(20_000));
    try {
      const models: { id: string; label: string }[] = [];
      let cursor: string | null = null;
      do {
        const page: ModelListResponse = await rpc.request("model/list", { cursor, limit: 100 });
        models.push(...page.data.filter((m) => !m.hidden).map((m) => ({ id: m.model, label: m.displayName })));
        cursor = page.nextCursor;
      } while (cursor && models.length < 500);
      return HarnessModels.parse(models);
    } finally { await rpc.close(); }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield* [];
  }
  const session = query({ prompt: input(), options: { pathToClaudeCodeExecutable: path, env, cwd: tmpdir(), abortController: controller, persistSession: false } });
  try {
    return HarnessModels.parse((await session.supportedModels()).map((m) => ({ id: m.value, label: m.displayName })));
  } finally { controller.abort(); clearTimeout(timer); session.close(); }
}
