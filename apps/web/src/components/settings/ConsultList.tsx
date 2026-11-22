import { X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import { useAgentName } from "../../lib/agent-name.ts";

export type ConsultEntry = { agentId: string };
export type ConsultMode = "disabled" | "auto" | "whitelist";
type OtherAgent = { id: string; name: string; builtIn?: string | null; plugin?: { name: string } | null; bundles: string[] };

const MODES: ConsultMode[] = ["disabled", "auto", "whitelist"];
/** What auto offers at most, as the server caps it. */
const AUTO_CAP = 50;

const configures = (bundles: string[]) => bundles.includes("configure");

/**
 * Which agents this one may consult: none, every agent on its side (auto), or those picked
 * (whitelist). The picks are kept in every mode. An agent that changes the workspace and one that
 * doesn't never consult each other: only agents on this one's side can be added, and an entry a
 * bundle change put on the other side since is shown inactive.
 */
export function ConsultList({
  agentId,
  bundles,
  mode,
  entries,
  agents,
  onModeChange,
  onChange,
}: {
  /** This agent, absent while it is being created. */
  agentId?: string;
  /** This agent's bundles as the form holds them. */
  bundles: string[];
  mode: ConsultMode;
  entries: ConsultEntry[];
  agents: OtherAgent[];
  onModeChange: (mode: ConsultMode) => void;
  onChange: (entries: ConsultEntry[]) => void;
}) {
  const { t } = useTranslation("agents");
  const agentName = useAgentName();
  const sameSide = (a: OtherAgent) => configures(a.bundles) === configures(bundles);
  const others = agents.filter((a) => a.id !== agentId && sameSide(a));
  const addable = others.filter((a) => !entries.some((e) => e.agentId === a.id));
  const editable = mode === "whitelist";
  return (
    <section aria-labelledby="agent-consults" className="space-y-2">
      <h3 id="agent-consults" className="text-[13px] font-medium text-muted">
        {t("consults.title")}
      </h3>
      <p className="text-[12px] text-faint">{t("consults.line")}</p>
      <div role="radiogroup" aria-labelledby="agent-consults" className="grid grid-cols-3 gap-1 rounded-xl border border-line p-1">
        {MODES.map((m) => (
          <label key={m} className={`flex cursor-pointer flex-col rounded-lg px-2 py-1.5 text-[13px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-accent)] ${mode === m ? "bg-hover font-medium" : "text-muted"}`}>
            <input type="radio" name="consult-mode" value={m} checked={mode === m} onChange={() => onModeChange(m)} className="sr-only" />
            <span>{t(`consults.modes.${m}.label`)}</span>
            <span className="text-[12px] font-normal text-faint">{t(`consults.modes.${m}.text`)}</span>
          </label>
        ))}
      </div>
      {mode === "auto" ? (
        <div className="space-y-1 text-[13px]">
          <p>{t("consults.auto")}</p>
          <p className="text-faint">{t("consults.autoCount", { count: Math.min(others.length, AUTO_CAP) })}</p>
          {others.length > AUTO_CAP && <p className="text-faint">{t("consults.autoCapped", { max: AUTO_CAP })}</p>}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-faint">{t(mode === "disabled" ? "consults.disabled" : "consults.none")}</p>
      ) : (
        <>
          <ul className={`divide-y divide-line rounded-xl border border-line ${editable ? "" : "opacity-60"}`}>
            {entries.map((e) => {
              const agent = agents.find((a) => a.id === e.agentId);
              const name = agent ? agentName(agent) : e.agentId;
              const inactive = agent && !sameSide(agent);
              return (
                <li key={e.agentId} className="space-y-1 px-3 py-2 text-[14px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{name}</span>
                    {editable && (
                      <button
                        type="button"
                        aria-label={t("consults.remove", { name })}
                        className="shrink-0 rounded p-0.5 text-muted hover:bg-hover"
                        onClick={() => onChange(entries.filter((x) => x.agentId !== e.agentId))}
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {inactive && <p className="text-[12px] text-danger">{t("consults.inactive")}</p>}
                </li>
              );
            })}
          </ul>
          {mode === "disabled" && <p className="text-[12px] text-faint">{t("consults.kept")}</p>}
        </>
      )}
      {editable && addable.length > 0 && (
        <Select value="" onValueChange={(id) => onChange([...entries, { agentId: id }])}>
          <SelectTrigger aria-label={t("consults.add")} className="w-full">
            <SelectValue placeholder={t("consults.add")} />
          </SelectTrigger>
          <SelectContent>
            {addable.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {agentName(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
