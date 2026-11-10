import type { OutputField } from "@dispand/runner-protocol";
import { MAX_ITERATIONS } from "@dispand/domain/workflows/loop";
import type { LoopStep, Ref, WorkflowDef } from "@dispand/domain/workflows/model";
import { useState } from "react";
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
  function set(patch: Partial<LoopStep>) {
    onChange({ ...def, steps: def.steps.map((s) => (s.id === step.id ? { ...step, ...patch } : s)) });
  }
  // What is typed, kept while it isn't a number the loop can take.
  const [typed, setTyped] = useState(String(step.maxIterations));
  const invalid = !/^\d+$/.test(typed) || Number(typed) < 1 || Number(typed) > MAX_ITERATIONS;

  return (
    <>
      <div className="space-y-3">
        <p className="text-[13px] font-medium text-muted">For each item of</p>
        <SourcePicker
          def={def}
          stepId={step.id}
          expected={expected}
          source={step.list}
          // Without `allowValue` the picker only gives values of upstream steps.
          onChange={(list) => set({ list: list as Ref | null })}
        />
        <FormField label="At most" htmlFor="loop-max" hint="A longer list makes the loop fail before its first iteration.">
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
              A whole number from 1 to {MAX_ITERATIONS}.
            </p>
          )}
        </FormField>
      </div>
      <p className="text-[13px] text-faint">
        Inside the loop, use <code className="font-mono">{`{{${step.key}.item}}`}</code> and <code className="font-mono">{`{{${step.key}.index}}`}</code>
        . After it, <code className="font-mono">{`{{${step.key}.count}}`}</code> and <code className="font-mono">{`{{${step.key}.results}}`}</code>.
      </p>
    </>
  );
}
