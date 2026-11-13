import { Button } from "@/components/ui/button";

/**
 * On a plugin's agent or tool: whose it is, and the fields its owner changed, each with the way
 * back to the plugin's value. `labels` names the fields as their form does.
 */
export function Overridden({ plugin, overridden, labels, busy, onReset }: { plugin: string; overridden: string[]; labels: Record<string, string>; busy: boolean; onReset: (field: string) => void }) {
  return (
    <div className="space-y-2 text-[13px] text-muted">
      <p>
        It is {plugin}'s. An update of the plugin replaces what you haven't changed, and it goes when the plugin is uninstalled.
      </p>
      {overridden.length > 0 && (
        <ul className="space-y-1">
          {overridden.map((field) => {
            const label = labels[field] ?? field;
            return (
              <li key={field} className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-medium text-fg">{label}</span>: yours, kept through updates
                </span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Reset ${label} to the plugin's`} onClick={() => onReset(field)}>
                  Reset to the plugin's
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
