export type AskAction = { name: string; description: string; readOnly: boolean; permission: "run" | "ask" | "off" };

/** Each action is enabled separately; enabling it starts with Ask rather than a silent grant. */
export function ToolAsk({ tool, actions, onChange, busy = false }: { tool: string; actions: AskAction[]; onChange: (action: string, permission: AskAction["permission"]) => void; busy?: boolean }) {
  if (actions.length === 0) return <p className="text-[12px] text-faint">No actions listed.</p>;
  const asking = actions.filter((a) => a.permission === "ask").length;
  const off = actions.filter((a) => a.permission === "off").length;
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-muted">
        {actions.length} {actions.length === 1 ? "action" : "actions"}, {asking} {asking === 1 ? "asks" : "ask"} before use{off > 0 ? `, ${off} off` : ""}
      </summary>
      <div role="group" aria-label={`Actions of ${tool}`} className="mt-2 space-y-2">
        {actions.map((a) => (
          <div key={a.name} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
            <label className="flex min-w-0 items-start gap-2">
              <input
                type="checkbox"
                aria-label={`Enable ${tool} ${a.name}`}
                disabled={busy}
                checked={a.permission !== "off"}
                onChange={(e) => onChange(a.name, e.target.checked ? "ask" : "off")}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span className="min-w-0">
                <code className="break-all font-mono text-[12.5px]">{a.name}</code>
                {a.readOnly && <span className="ml-2 text-[12px] text-faint">read-only, according to the tool</span>}
                {a.description && <span className="block truncate text-[12px] text-faint">{a.description}</span>}
              </span>
            </label>
            {a.permission !== "off" && <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted">
              Ask before use
              <input
                type="checkbox"
                role="switch"
                aria-label={`Ask before ${tool} ${a.name}`}
                disabled={busy}
                checked={a.permission === "ask"}
                onChange={(e) => onChange(a.name, e.target.checked ? "ask" : "run")}
                className="size-4 accent-[var(--color-accent)]"
              />
            </label>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-faint">Disabled actions stop immediately. Re-enabled actions are available in a new CLI session.</p>
    </details>
  );
}
