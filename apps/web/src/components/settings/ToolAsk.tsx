export type AskAction = { name: string; description: string; readOnly: boolean; ask: boolean };

/**
 * The actions of one of an agent's tools, each with its "ask before use" switch. A change is
 * handed over at once (it is saved apart from the agent's form): taking a question away is the
 * owner's own doing, here.
 */
export function ToolAsk({ tool, actions, onChange, busy = false }: { tool: string; actions: AskAction[]; onChange: (action: string, ask: boolean) => void; busy?: boolean }) {
  if (actions.length === 0) return <p className="text-[12px] text-faint">No actions listed.</p>;
  const asking = actions.filter((a) => a.ask).length;
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-muted">
        {actions.length} {actions.length === 1 ? "action" : "actions"}, {asking} {asking === 1 ? "asks" : "ask"} before use
      </summary>
      <div role="group" aria-label={`Actions of ${tool}`} className="mt-2 space-y-2">
        {actions.map((a) => (
          <label key={a.name} className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <code className="font-mono text-[12.5px]">{a.name}</code>
              {a.readOnly && <span className="ml-2 text-[12px] text-faint">read-only, according to the tool</span>}
              {a.description && <span className="block truncate text-[12px] text-faint">{a.description}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted">
              Ask before use
              <input
                type="checkbox"
                role="switch"
                aria-label={`Ask before ${tool} ${a.name}`}
                disabled={busy}
                checked={a.ask}
                onChange={(e) => onChange(a.name, e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}
