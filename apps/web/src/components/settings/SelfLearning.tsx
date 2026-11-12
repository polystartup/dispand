import type { MemoryTarget } from "@dispand/domain/memory/model";

/** What writing the workspace's memory means: every agent reads it (a proposal item says it too). */
export const WORKSPACE_LINE = "What it writes steers every agent of the workspace.";

/** Each target in words, in the order the switches show them. */
export const TARGET_TEXT: [MemoryTarget, string, string][] = [
  ["agent", "Its own memory", "Its Jobs keep what they learn for its next Jobs."],
  ["data", "Its tables' memory", "Its Jobs keep what they learn about the tables they work on, for every agent working on them. Needs “Work on data”."],
  ["workspace", "The workspace's memory", WORKSPACE_LINE],
];

const box = "mt-1 size-4 accent-[var(--color-accent)]";

/** The agent's self-learning switch: where its Jobs may write memory. None ticked, it learns nothing. */
export function SelfLearning({ targets, onChange }: { targets: MemoryTarget[]; onChange: (targets: MemoryTarget[]) => void }) {
  const toggle = (target: MemoryTarget, on: boolean) => onChange(TARGET_TEXT.map(([t]) => t).filter((t) => (t === target ? on : targets.includes(t))));
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-[13px] font-medium text-muted">Learns</legend>
      {TARGET_TEXT.map(([target, label, text]) => (
        <label key={target} className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" className={box} checked={targets.includes(target)} onChange={(e) => toggle(target, e.target.checked)} />
          <span>
            {label}
            <span className="block text-[12px] text-faint">{text}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
