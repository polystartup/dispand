import type { OutputField } from "@dispand/runner-protocol";
import { MAX_ITERATIONS } from "@dispand/domain/workflows/loop";
import type { LoopStep, Ref, WorkflowDef } from "@dispand/domain/workflows/model";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { FormField } from "../../settings/parts.tsx";
import { SourcePicker } from "../SourcePicker.tsx";

/** A loop's body: the list it goes through (a JSON array from upstream) and how many items it takes at most. */
export function LoopPanel({
  def,
  step,
  expected,
  onChange,
}: {
  def: WorkflowDef;
  step: LoopStep;
  expected: Record<string, OutputField[]>;
  onChange: (def: WorkflowDef) => void;
}) {
  const { t } = useTranslation("workflows");
  function set(patch: Partial<LoopStep>) {
    onChange({ ...def, steps: def.steps.map((s) => (s.id === step.id ? { ...step, ...patch } : s)) });
  }
  // What is typed, kept while it isn't a number the loop can take.
  const [typed, setTyped] = useState(String(step.maxIterations));
  const invalid = !/^\d+$/.test(typed) || Number(typed) < 1 || Number(typed) > MAX_ITERATIONS;

  return (
    <>
      <div className="space-y-3">
        <p className="text-[13px] font-medium text-muted">{t("loop.each")}</p>
        <SourcePicker
          def={def}
          stepId={step.id}
          expected={expected}
          source={step.list}
          // Without `allowValue` the picker only gives values of upstream steps.
          onChange={(list) => set({ list: list as Ref | null })}
        />
        <FormField label={t("loop.atMost")} htmlFor="loop-max" hint={t("loop.hint")}>
          <Input
            id="loop-max"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_ITERATIONS}
            value={typed}
            aria-invalid={invalid}
            onChange={(e) => {
              setTyped(e.target.value);
              if (/^\d+$/.test(e.target.value) && Number(e.target.value) >= 1 && Number(e.target.value) <= MAX_ITERATIONS) set({ maxIterations: Number(e.target.value) });
            }}
          />
          {invalid && (
            <p role="alert" className="mt-1.5 text-[13px] text-danger">
              {t("loop.invalid", { max: MAX_ITERATIONS })}
            </p>
          )}
        </FormField>
      </div>
      <p className="text-[13px] text-faint">
        <Trans
          t={t}
          i18nKey="loop.footer"
          values={{ item: `{{${step.key}.item}}`, index: `{{${step.key}.index}}`, total: `{{${step.key}.count}}`, results: `{{${step.key}.results}}` }}
          components={[<code key="item" className="font-mono" />, <code key="index" className="font-mono" />, <code key="count" className="font-mono" />, <code key="results" className="font-mono" />]}
        />
      </p>
    </>
  );
}
