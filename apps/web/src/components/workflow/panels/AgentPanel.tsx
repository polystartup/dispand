import type { OutputField } from "@dispand/runner-protocol";
import { upstreamOf } from "@dispand/domain/workflows/derive";
import { nodesOf, type WorkflowDef, type WorkflowNode } from "@dispand/domain/workflows/model";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FormField } from "../../settings/parts.tsx";

type Agent = { id: string; name: string };

/** An agent-driven node's body (a chat trigger or an agent step): agent, prompt, expected outputs. */
export function AgentPanel({
  def,
  node,
  agents,
  expected,
  onChange,
}: {
  def: WorkflowDef;
  node: WorkflowNode;
  agents: Agent[];
  expected: Record<string, OutputField[]>;
  onChange: (def: WorkflowDef) => void;
}) {
  const nodeId = node.id;
  const trigger = def.trigger.field;
  const isTrigger = node.kind === "trigger";
  const outputs = expected[nodeId] ?? [];

  function setAgent(agentId: string) {
    if (isTrigger) {
      if (trigger.type === "chat") onChange({ ...def, trigger: { type: "manual", field: { ...trigger, agentId } } });
    } else onChange({ ...def, steps: def.steps.map((s) => (s.id === nodeId ? { ...s, agentId } : s)) });
  }
  function setPrompt(prompt: string) {
    if (isTrigger) {
      if (trigger.type === "chat") onChange({ ...def, trigger: { type: "manual", field: { ...trigger, prompt } } });
    } else onChange({ ...def, steps: def.steps.map((s) => (s.id === nodeId ? { ...s, prompt } : s)) });
  }

  return (
    <>
      <FormField label="Agent" htmlFor="node-agent">
        <Select value={node.agentId ?? ""} onValueChange={setAgent}>
          <SelectTrigger id="node-agent" className="w-full">
            <SelectValue placeholder="Choose an agent" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <PromptEditor
        value={node.prompt ?? ""}
        onChange={setPrompt}
        suggestions={suggestionsFor(def, nodeId, expected)}
        hint={isTrigger ? "What the agent should find out in the chat." : "Type {{ to use a value from an earlier step."}
      />
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-muted">Expected outputs</p>
        {outputs.length === 0 ? (
          <p className="text-[13px] text-faint">
            None yet. A later prompt that uses <code className="font-mono">{`{{${node.key}.name}}`}</code> asks this step for
            “name”.
          </p>
        ) : (
          <ul aria-label="Expected outputs" className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line">
            {outputs.map((o) => (
              <li key={o.name} className="px-3 py-2 text-[13px]">
                <span className="block font-mono">{o.name}</span>
                {o.description && <span className="block text-[12px] text-faint">{o.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** `key.field` for the fields upstream nodes already give, and `key.` to name a new one. */
function suggestionsFor(def: WorkflowDef, nodeId: string, expected: Record<string, OutputField[]>): string[] {
  const upstream = upstreamOf(def, nodeId);
  return nodesOf(def)
    .filter((n) => upstream.has(n.id) && n.id !== nodeId)
    .flatMap((n) => [...(expected[n.id] ?? []).map((f) => `${n.key}.${f.name}`), `${n.key}.`]);
}

/** A prompt textarea that completes `{{` with upstream keys. */
function PromptEditor({
  value,
  onChange,
  suggestions,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  hint: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);
  const caretAfter = useRef<{ value: string; at: number } | null>(null);
  const options = query ? suggestions.filter((s) => s.startsWith(query.text) && s !== query.text) : [];
  const open = options.length > 0;

  /** The `{{partial` right before the caret, if any. */
  function update(text: string, caret: number) {
    const m = /\{\{\s*([a-z0-9_]*(?:\.[A-Za-z0-9_]*)?)$/.exec(text.slice(0, caret));
    setQuery(m ? { start: m.index, text: m[1]! } : null);
    setActive(0);
  }

  function pick(option: string) {
    if (!query || !ref.current) return;
    const caret = ref.current.selectionStart;
    const inserted = option.endsWith(".") ? `{{${option}` : `{{${option}}}`;
    const next = value.slice(0, query.start) + inserted + value.slice(caret);
    onChange(next);
    const at = query.start + inserted.length;
    setQuery(option.endsWith(".") ? { start: query.start, text: option } : null);
    caretAfter.current = { value: next, at };
  }

  // The caret goes after the pick as soon as the picked text is shown, before the next key is
  // handled: a later frame would move it back behind characters typed meanwhile.
  useLayoutEffect(() => {
    const pending = caretAfter.current;
    if (!pending || pending.value !== value || !ref.current) return;
    caretAfter.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(pending.at, pending.at);
  });

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(options[active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery(null);
    }
  }

  return (
    <FormField label="Prompt" htmlFor="node-prompt" hint={hint}>
      <div className="relative">
        <Textarea
          id="node-prompt"
          ref={ref}
          value={value}
          rows={4}
          maxLength={100_000}
          className="min-h-24 rounded-xl font-mono text-[13px]"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            update(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setQuery(null)}
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Values from earlier steps"
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-auto rounded-xl bg-surface p-1 shadow-pop"
          >
            {options.map((o, i) => (
              <li
                key={o}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                className={cn("cursor-pointer rounded-lg px-2.5 py-1.5 font-mono text-[13px]", i === active && "bg-active")}
              >
                {o.endsWith(".") ? `${o}…` : o}
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormField>
  );
}
