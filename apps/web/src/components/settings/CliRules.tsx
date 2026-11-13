import type { api } from "../../lib/api.ts";
import { Button } from "@/components/ui/button";

type Rule = Awaited<ReturnType<typeof api.agents.cliRules>>[number];

export function CliRules({ rules, busy, onRemove }: { rules: Rule[]; busy: boolean; onRemove: (rule: Rule) => void }) {
  return (
    <section aria-labelledby="agent-cli-rules" className="space-y-2">
      <h3 id="agent-cli-rules" className="text-[13px] font-medium text-muted">Remembered CLI permissions</h3>
      <p className="text-[12px] text-faint">Removing a rule takes effect when this agent starts its next session.</p>
      {rules.length === 0 ? <p className="text-[13px] text-faint">No remembered CLI permissions.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rules.map((rule) => {
            const cli = rule.cli === "claude-code" ? "Claude Code" : "Codex";
            const decision = rule.decision === "allow" ? "Allow" : "Deny";
            return <li key={`${rule.cli}:${rule.rule}`} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <span className="text-[12px] text-muted">{cli} · {decision}</span>
                <code className="block break-all font-mono text-[12.5px]">{rule.rule}</code>
              </div>
              <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${cli} ${decision} ${rule.rule}`} onClick={() => onRemove(rule)}>Remove</Button>
            </li>;
          })}
        </ul>
      )}
    </section>
  );
}
