import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState, type ComponentProps } from "react";
import { orpc } from "../../lib/api.ts";
import { ChatInput } from "../chat/Thread.tsx";

type Entry = { name: string; description: string; source: "harness" | "dispand"; skillId?: string };

type Props = {
  agentId: string;
  runId: string | null;
  inputProps: ComponentProps<typeof ChatInput>;
  onTextChange: (text: string) => void;
  onSkillChange: (entry: Entry) => void;
};

/** The Assistant's slash menu; selection edits the draft and never submits it. */
export function AssistantInput({ agentId, runId, inputProps, onTextChange, onSkillChange }: Props) {
  const text = String(inputProps.value ?? "");
  const query = /^\/([^\s]*)$/.exec(text)?.[1];
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const catalog = useQuery({ ...orpc.assistantCommands.queryOptions({ input: { agentId, ...(runId ? { runId } : {}) } }), enabled: query !== undefined, retry: false });
  const open = query !== undefined && dismissed !== text && !inputProps.disabled;
  const entries = (catalog.data?.entries ?? []).filter((e) => `${e.name} ${e.description}`.toLowerCase().includes((query ?? "").toLowerCase()));
  const index = Math.min(active, Math.max(0, entries.length - 1));
  function select(entry: Entry) {
    onTextChange(`/${entry.name} `);
    onSkillChange(entry);
    setDismissed(null);
    setActive(0);
    root.current?.querySelector("textarea")?.focus();
  }
  return <div ref={root} className={`${inputProps.className?.includes("basis-full") ? "w-full basis-full" : "min-w-0 flex-1"} relative`}>
    {open && <div className="absolute bottom-full z-50 mb-2 max-h-72 w-full min-w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
      {catalog.isPending && <p role="status" className="px-3 py-2 text-sm text-muted">Loading commands and skills…</p>}
      {(catalog.error || catalog.data?.nativeUnavailable) && <p role="status" className="px-3 py-2 text-sm text-muted">Harness commands unavailable. Showing Dispand skills.</p>}
      {catalog.data?.skillsOnly && <p className="px-3 py-1 text-xs text-muted">Codex skills · built-in commands are not exposed by the harness.</p>}
      <div id={id} role="listbox" aria-label="Commands and skills">
        {entries.map((entry, i) => <button key={`${entry.source}:${entry.name}`} id={`${id}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => select(entry)} className={`block w-full rounded-lg px-3 py-2 text-left ${i === index ? "bg-hover" : "hover:bg-hover"}`}>
          <span className="block text-sm">/{entry.name} <span className="text-xs text-muted">{entry.source === "dispand" ? "Dispand" : "Harness"}</span></span>
          <span className="block text-xs text-muted">{entry.description}</span>
        </button>)}
      </div>
      {!catalog.isPending && entries.length === 0 && <p className="px-3 py-2 text-sm text-muted">No matching commands or skills.</p>}
    </div>}
    <ChatInput {...inputProps} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open && entries.length ? `${id}-${index}` : undefined}
      onChange={(e) => { setDismissed(null); setActive(0); inputProps.onChange?.(e); }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(text); return; }
        if (open && entries.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setActive((index + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length); return; }
        if (open && entries.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey))) { e.preventDefault(); select(entries[index]!); return; }
        if (open && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); return; }
        inputProps.onKeyDown?.(e);
      }} />
  </div>;
}
