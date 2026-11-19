import { AuiIf, ComposerPrimitive, QueueItemPrimitive, useAuiState } from "@assistant-ui/react";
import { Clock, CircleAlert, Pencil, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStored } from "@/lib/message";
import type { RunSnapshot } from "../../lib/run-state.ts";

type Queued = RunSnapshot["queue"][number];

type Props = {
  /** The run's queued messages, by id: the library's item carries only its words. */
  queued: ReadonlyMap<string, Queued>;
  /** Saves new words for a pending item; false when they didn't land (the item was sent first). */
  onEdit: (queuedId: string, text: string) => Promise<boolean>;
};

/** The messages waiting for the agent's turn to end, above the composer: each can be edited or removed until it goes. */
export function QueuedMessages(props: Props) {
  const { t } = useTranslation("chat");
  return <AuiIf condition={(s) => s.composer.queue.length > 0}>
    <div role="list" aria-label={t("queuedMessages")} className="mx-auto mb-2 flex max-h-48 w-full max-w-3xl flex-col gap-1.5 overflow-y-auto">
      <ComposerPrimitive.Queue>{() => <QueuedMessage {...props} />}</ComposerPrimitive.Queue>
    </div>
  </AuiIf>;
}

function QueuedMessage({ queued, onEdit }: Props) {
  const { t } = useTranslation("chat");
  const stored = useStored();
  const id = useAuiState((s) => s.queueItem.id);
  const words = useAuiState((s) => s.queueItem.prompt);
  const item = queued.get(id);
  const failed = item?.state === "failed";
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    if (draft === null || !draft.trim()) return;
    setSaving(true);
    const saved = await onEdit(id, draft.trim());
    setSaving(false);
    if (saved) setDraft(null);
  }
  return <div role="listitem" className="flex items-start gap-2 rounded-xl border border-line bg-hover px-3 py-2 text-sm">
    {failed ? <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden /> : <Clock size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />}
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {draft === null
        ? <QueueItemPrimitive.Text className="whitespace-pre-wrap break-words text-fg" />
        : <textarea aria-label={t("editQueued")} value={draft} autoFocus rows={2} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
            }}
            className="w-full resize-none rounded-lg border border-line bg-surface px-2 py-1 text-fg outline-none focus:border-accent" />}
      <span className={`text-[12px] ${failed ? "text-danger" : "text-muted"}`}>
        {failed ? (item.error ? t("queuedFailed", { error: stored(item.error) }) : t("queuedFailedPlain")) : t("queuedWaiting")}
      </span>
    </div>
    {!failed && (draft === null
      ? <Button type="button" variant="ghost" size="icon-sm" aria-label={t("editQueued")} title={t("editQueued")} className="rounded-full text-muted" onClick={() => setDraft(words)}><Pencil aria-hidden /></Button>
      : <>
        <Button type="button" size="sm" disabled={saving || !draft.trim()} onClick={() => void save()} className="rounded-full">{t("saveQueued")}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)} className="rounded-full">{t("cancelEdit")}</Button>
      </>)}
    <QueueItemPrimitive.Remove asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeQueued")} title={t("removeQueued")} disabled={saving} className="rounded-full text-muted"><X aria-hidden /></Button></QueueItemPrimitive.Remove>
  </div>;
}
