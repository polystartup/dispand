import { X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import type { ConsultMode } from "./ConsultList.tsx";

/** A picked person, as `agents.get` gives them: whether they are a member now and wrote a profile. */
export type EscalationEntry = { userId: string; name?: string; member?: boolean; profile?: boolean };
/** A member of the workspace, as `agents.people` gives them. */
export type Member = { id: string; name: string; profile: boolean };

const MODES: ConsultMode[] = ["disabled", "auto", "whitelist"];
/** What auto offers at most, as the server caps it. */
const AUTO_CAP = 50;

/**
 * Which people this agent may ask outside a chat: none, every member with a profile (auto), or
 * those picked (whitelist). The picks are kept in every mode; someone who left stays listed, and
 * is skipped.
 */
export function EscalationList({
  mode,
  entries,
  members,
  onModeChange,
  onChange,
}: {
  mode: ConsultMode;
  entries: EscalationEntry[];
  members: Member[];
  onModeChange: (mode: ConsultMode) => void;
  onChange: (entries: EscalationEntry[]) => void;
}) {
  const { t } = useTranslation("agents");
  const addable = members.filter((m) => !entries.some((e) => e.userId === m.id));
  const profiled = members.filter((m) => m.profile);
  const editable = mode === "whitelist";
  return (
    <section aria-labelledby="agent-escalations" className="space-y-2">
      <h3 id="agent-escalations" className="text-[13px] font-medium text-muted">
        {t("escalations.title")}
      </h3>
      <p className="text-[12px] text-faint">{t("escalations.line")}</p>
      <div role="radiogroup" aria-labelledby="agent-escalations" className="grid grid-cols-3 gap-1 rounded-xl border border-line p-1">
        {MODES.map((m) => (
          <label key={m} className={`flex cursor-pointer flex-col rounded-lg px-2 py-1.5 text-[13px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-accent)] ${mode === m ? "bg-hover font-medium" : "text-muted"}`}>
            <input type="radio" name="escalate-mode" value={m} checked={mode === m} onChange={() => onModeChange(m)} className="sr-only" />
            <span>{t(`escalations.modes.${m}.label`)}</span>
            <span className="text-[12px] font-normal text-faint">{t(`escalations.modes.${m}.text`)}</span>
          </label>
        ))}
      </div>
      {mode === "auto" ? (
        <div className="space-y-1 text-[13px]">
          <p>{t("escalations.auto")}</p>
          <p className="text-faint">{t("escalations.autoCount", { count: Math.min(profiled.length, AUTO_CAP) })}</p>
          {profiled.length > AUTO_CAP && <p className="text-faint">{t("escalations.autoCapped", { max: AUTO_CAP })}</p>}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-[13px] text-faint">{t(mode === "disabled" ? "escalations.disabled" : "escalations.none")}</p>
      ) : (
        <>
          <ul className={`divide-y divide-line rounded-xl border border-line ${editable ? "" : "opacity-60"}`}>
            {entries.map((e) => {
              const member = members.find((m) => m.id === e.userId);
              const name = member?.name ?? e.name ?? e.userId;
              // Read live from the members list once loaded: a pick just added is a member.
              const left = member === undefined && e.member === false;
              const noProfile = member ? !member.profile : e.profile === false;
              return (
                <li key={e.userId} className="space-y-1 px-3 py-2 text-[14px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{name}</span>
                    {editable && (
                      <button
                        type="button"
                        aria-label={t("escalations.remove", { name })}
                        className="shrink-0 rounded p-0.5 text-muted hover:bg-hover"
                        onClick={() => onChange(entries.filter((x) => x.userId !== e.userId))}
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {left ? (
                    <p className="text-[12px] text-danger">{t("escalations.left")}</p>
                  ) : (
                    noProfile && <p className="text-[12px] text-faint">{t("escalations.noProfile")}</p>
                  )}
                </li>
              );
            })}
          </ul>
          {mode === "disabled" && <p className="text-[12px] text-faint">{t("escalations.kept")}</p>}
        </>
      )}
      {editable && addable.length > 0 && (
        <Select value="" onValueChange={(id) => onChange([...entries, { userId: id }])}>
          <SelectTrigger aria-label={t("escalations.add")} className="w-full">
            <SelectValue placeholder={t("escalations.add")} />
          </SelectTrigger>
          <SelectContent>
            {addable.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </section>
  );
}
