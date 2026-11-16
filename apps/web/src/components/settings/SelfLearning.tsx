import type { MemoryTarget } from "@dispand/domain/memory/model";
import { useTranslation } from "react-i18next";

/**
 * The targets in the order the switches show them; each is named by `agents:learns.<target>.label`
 * and `.text` (the workspace's says what writing it means, as a proposal item does too).
 */
export const TARGETS: MemoryTarget[] = ["agent", "data", "workspace"];

const box = "mt-1 size-4 accent-[var(--color-accent)]";

/** The agent's self-learning switch: where its Jobs may write memory. None ticked, it learns nothing. */
export function SelfLearning({ targets, onChange }: { targets: MemoryTarget[]; onChange: (targets: MemoryTarget[]) => void }) {
  const { t } = useTranslation("agents");
  const toggle = (target: MemoryTarget, on: boolean) => onChange(TARGETS.filter((x) => (x === target ? on : targets.includes(x))));
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-[13px] font-medium text-muted">{t("learns.title")}</legend>
      {TARGETS.map((target) => (
        <label key={target} className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" className={box} checked={targets.includes(target)} onChange={(e) => toggle(target, e.target.checked)} />
          <span>
            {t(`learns.${target}.label`)}
            <span className="block text-[12px] text-faint">{t(`learns.${target}.text`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
