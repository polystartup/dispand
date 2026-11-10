import type { OutputField } from "@dispand/runner-protocol";
import type { FieldSchema } from "@dispand/domain/data/fields";
import { isOutputName, sourceFields } from "@dispand/domain/workflows/derive";
import { nodesOf, upstreamOf, type Ref, type Source, type WorkflowDef } from "@dispand/domain/workflows/model";
import { useId, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { FormField } from "../settings/parts.tsx";
import { selectClass } from "../data/NewFieldPopover.tsx";

/** The "From" option for a literal. */
const VALUE = "__value";

/**
 * Where a step's value comes from: an upstream step that gives values (a chat or agent step is
 * asked for it by the name typed here, others give a fixed list), or, with `allowValue`, a value
 * typed here, its input fitted to `field`. A name that can't be a value isn't passed on: `onChange`
 * gets `null` until it can.
 */
export function SourcePicker({
  def,
  stepId,
  expected,
  source,
  onChange,
  allowValue = false,
  field,
  defaultName = "",
  label,
}: {
  def: WorkflowDef;
  stepId: string;
  expected: Record<string, OutputField[]>;
  source: Source | null;
  onChange: (source: Source | null) => void;
  allowValue?: boolean;
  /** The field a typed value goes into. */
  field?: FieldSchema;
  /** The name a chat or agent step is asked for when nothing is named yet. */
  defaultName?: string;
  /** Groups the picker under this name (several pickers in one panel). */
  label?: string;
}) {
  const id = useId();
  const nameHint = useId();
  const listId = useId();
  // Upstream nodes that give values: an agent-driven one gives whatever is asked of it.
  const upstream = upstreamOf(def, stepId);
  const sources = nodesOf(def).flatMap((n) => {
    if (!upstream.has(n.id) || n.id === stepId) return [];
    const gives = sourceFields(def, n.id, stepId);
    if (gives.kind === "fixed" && gives.fields.length === 0) return [];
    return [{ node: n, gives }];
  });
  // The step and the name being typed, kept while the name can't be a value yet.
  const [from, setFrom] = useState(source === null ? "" : source.type === "value" ? VALUE : source.nodeId);
  const [name, setName] = useState(source?.type === "output" ? source.name : "");
  const picked = sources.find((s) => s.node.id === from);

  function setRef(nodeId: string, fieldName: string) {
    setFrom(nodeId);
    setName(fieldName);
    const ref: Ref | null = nodeId && isOutputName(fieldName) ? { type: "output", nodeId, name: fieldName } : null;
    onChange(ref);
  }
  function pickFrom(nodeId: string) {
    if (nodeId === VALUE) {
      setFrom(VALUE);
      onChange({ type: "value", value: "" });
      return;
    }
    const next = sources.find((s) => s.node.id === nodeId);
    if (next?.gives.kind === "fixed") {
      setRef(nodeId, next.gives.fields.includes(name) ? name : (next.gives.fields[0] ?? ""));
      return;
    }
    // A chat or agent step: it is asked for the same name, so rewiring moves the value to it.
    const keep = isOutputName(name) ? name : "";
    setRef(nodeId, keep || defaultName || (next?.node.type === "loop" ? "item" : (expected[nodeId]?.[0]?.name ?? "")));
  }

  const nameInvalid = picked !== undefined && picked.gives.kind !== "fixed" && name !== "" && !isOutputName(name);

  const body: ReactNode = (
    <div className="space-y-3">
      <FormField label="From" htmlFor={`${id}-from`}>
        <select id={`${id}-from`} value={picked || from === VALUE ? from : ""} onChange={(e) => pickFrom(e.target.value)} className={selectClass}>
          <option value="" disabled>
            Choose a step
          </option>
          {sources.map(({ node }) => (
            <option key={node.id} value={node.id}>
              {node.name || "Untitled"}
            </option>
          ))}
          {allowValue && <option value={VALUE}>A value</option>}
        </select>
      </FormField>
      {from === VALUE && source?.type === "value" && (
        <FormField label="Value" htmlFor={`${id}-value`}>
          <ValueInput id={`${id}-value`} field={field} value={source.value} onChange={(value) => onChange({ type: "value", value })} />
        </FormField>
      )}
      {picked &&
        (picked.gives.kind === "fixed" ? (
          <FormField label="Value" htmlFor={`${id}-value`}>
            <select id={`${id}-value`} value={name} onChange={(e) => setRef(from, e.target.value)} className={selectClass}>
              {picked.gives.fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </FormField>
        ) : (
          <FormField
            label="Value"
            htmlFor={`${id}-value`}
            hint={
              picked.node.type === "loop"
                ? `The item, its index or a field of the item, like {{${picked.node.key}.${name || "item"}}}.`
                : `${picked.node.name || "Untitled"} is asked for it, like {{${picked.node.key}.${name || "name"}}}.`
            }
          >
            <Input
              id={`${id}-value`}
              value={name}
              maxLength={64}
              list={listId}
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? nameHint : undefined}
              className="font-mono text-[13px]"
              onChange={(e) => setRef(from, e.target.value.trim())}
            />
            <datalist id={listId}>
              {(picked.node.type === "loop" ? ["item", "index"] : (expected[from] ?? []).map((f) => f.name)).map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            {nameInvalid && (
              <p id={nameHint} role="alert" className="mt-1.5 text-[13px] text-danger">
                A value's name is letters, digits and _, not starting with a digit.
              </p>
            )}
          </FormField>
        ))}
    </div>
  );

  if (label === undefined) return body;
  return (
    <fieldset className="space-y-2 rounded-xl p-3 ring-1 ring-line">
      <legend className="px-1 text-[13px] font-medium">{label}</legend>
      {body}
    </fieldset>
  );
}

/** A literal as text, its input fitted to the field it goes into (`parseCellText` reads it). */
function ValueInput({ id, field, value, onChange }: { id: string; field?: FieldSchema; value: string; onChange: (value: string) => void }) {
  if (field?.type === "checkbox" || field?.type === "single-select") {
    const options = field.type === "checkbox" ? [{ value: "true", label: "Checked" }, { value: "false", label: "Unchecked" }] : field.choices.map((c) => ({ value: c.label, label: c.label }));
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        <option value="">Empty</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  const type = field?.type === "date" ? "date" : field?.type === "url" ? "url" : "text";
  return (
    <Input
      id={id}
      type={type}
      inputMode={field?.type === "number" ? "decimal" : undefined}
      value={value}
      maxLength={10_000}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
