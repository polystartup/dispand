import { ComposerPrimitive, unstable_useSlashCommandAdapter } from "@assistant-ui/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ComponentProps } from "react";
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

const matchLeadingSlash: ComposerPrimitive.TriggerMatcher = (text, _char, cursor) => {
  const query = /^\/([^\s]*)$/.exec(text)?.[1];
  return cursor > 0 && query !== undefined ? { query, offset: 0, endOffset: text.length } : null;
};

function CommandInput({ empty, ...props }: ComponentProps<typeof ChatInput> & { empty: boolean }) {
  const root = ComposerPrimitive.unstable_useTriggerPopoverRootContext();
  return <ChatInput {...props} onKeyDownCapture={(event) => {
    props.onKeyDownCapture?.(event);
    const menu = root.getTriggers().get("/")?.resource;
    // The stock trigger consumes empty-list Tab; retain native focus navigation instead.
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === "Tab" && empty && menu) {
      menu.close();
      event.stopPropagation();
    }
  }} />;
}

/** The stock slash picker edits the draft and records skill identity, never submits it. */
export function AssistantInput({ agentId, runId, inputProps, onTextChange, onSkillChange }: Props) {
  const { t } = useTranslation("assistant");
  const query = /^\/([^\s]*)$/.exec(String(inputProps.value ?? ""))?.[1];
  const catalog = useQuery({ ...orpc.assistantCommands.queryOptions({ input: { agentId, ...(runId ? { runId } : {}) } }), enabled: query !== undefined && !inputProps.disabled, retry: false });
  const entries = catalog.data?.entries ?? [];
  const slash = unstable_useSlashCommandAdapter({
    removeOnExecute: true,
    commands: entries.map((entry) => ({
      id: `${entry.source}:${entry.name}`,
      label: `/${entry.name}`,
      description: entry.description,
      execute: () => { onTextChange(`/${entry.name} `); onSkillChange(entry); },
    })),
  });
  return <ComposerPrimitive.TriggerPopoverRoot>
    <div className={`${inputProps.className?.includes("basis-full") ? "w-full basis-full" : "min-w-0 flex-1"} relative`}>
      <ComposerPrimitive.TriggerPopover char="/" matcher={matchLeadingSlash} adapter={inputProps.disabled ? undefined : slash.adapter} isLoading={catalog.isPending} aria-label={t("commandsLabel")} className="absolute bottom-full z-50 mb-2 max-h-72 w-full min-w-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
        <ComposerPrimitive.TriggerPopover.Action {...slash.action} />
        <ComposerPrimitive.TriggerPopoverItems aria-label={t("commandsLabel")}>
          {(items) => <>
            {catalog.isPending && <p role="status" className="px-3 py-2 text-sm text-muted">{t("commandsLoading")}</p>}
            {(catalog.error || catalog.data?.nativeUnavailable) && <p role="status" className="px-3 py-2 text-sm text-muted">{t("commandsUnavailable")}</p>}
            {catalog.data?.skillsOnly && <p className="px-3 py-1 text-xs text-muted">{t("skillsOnly")}</p>}
            {items.map((item, index) => <ComposerPrimitive.TriggerPopoverItem key={item.id} item={item} index={index} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-hover data-highlighted:bg-hover">
              <span className="block text-sm">{item.label} <span className="text-xs text-muted">{entries.find((entry) => `${entry.source}:${entry.name}` === item.id)?.source === "dispand" ? "Dispand" : t("sourceHarness")}</span></span>
              <span className="block text-xs text-muted">{item.description}</span>
            </ComposerPrimitive.TriggerPopoverItem>)}
            {!catalog.isPending && items.length === 0 && <p className="px-3 py-2 text-sm text-muted">{t("commandsNone")}</p>}
          </>}
        </ComposerPrimitive.TriggerPopoverItems>
      </ComposerPrimitive.TriggerPopover>
      <CommandInput {...inputProps} empty={query !== undefined && slash.adapter.search!(query).length === 0} />
    </div>
  </ComposerPrimitive.TriggerPopoverRoot>;
}
