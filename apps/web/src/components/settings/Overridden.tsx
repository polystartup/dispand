import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * On a plugin's agent or tool: whose it is, and the fields its owner changed, each with the way
 * back to the plugin's value. `labels` names the fields as their form does.
 */
export function Overridden({ plugin, overridden, labels, busy, onReset }: { plugin: string; overridden: string[]; labels: Record<string, string>; busy: boolean; onReset: (field: string) => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-2 text-[13px] text-muted">
      <p>{t("overridden.text", { plugin })}</p>
      {overridden.length > 0 && (
        <ul className="space-y-1">
          {overridden.map((field) => {
            const label = labels[field] ?? field;
            return (
              <li key={field} className="flex items-center justify-between gap-3">
                <span>
                  <Trans t={t} i18nKey="overridden.yours" values={{ label }} components={[<span className="font-medium text-fg" />]} />
                </span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t("overridden.resetLabel", { label })} onClick={() => onReset(field)}>
                  {t("overridden.reset")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
