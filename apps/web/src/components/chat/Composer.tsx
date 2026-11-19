import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, MessageSquarePlus, Paperclip, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AssistantInput } from "../assistant/AssistantInput.tsx";
import { ComposerAttachment } from "./Attachment.tsx";
import { ChatInput, ComposerQuote } from "./Thread.tsx";

type Props = {
  runId: string | null;
  assistantAgentId?: string;
  tools?: ReactNode;
  open: boolean;
  waiting?: "question" | "proposal";
  busy: boolean;
  error: string | null;
  /** The messages queued while the agent works (`QueuedMessages`). */
  queued?: ReactNode;
  onNewConversation?: () => void;
};

export function ChatComposer({ runId, assistantAgentId, tools, open, waiting, busy, error, queued, onNewConversation }: Props) {
  const { t } = useTranslation("chat");
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const canSend = useAuiState((s) => s.composer.canSend);
  const running = useAuiState((s) => s.thread.isRunning);
  // Cancel also cancels local submission; our API only interrupts an established turn.
  const canStop = useAuiState((s) => s.thread.isRunning && s.thread.capabilities.cancel && s.composer.submission === undefined);
  function chooseSkill(entry: { name: string; skillId?: string }) {
    const config = aui.composer().getState().runConfig;
    aui.composer().setRunConfig({ ...config, custom: { ...config.custom, skill: entry } });
  }
  const input = <ChatInput aria-label={t("message")} minRows={1} disabled={!open || waiting === "question"}
    placeholder={!open ? t("over") : t("message")}
    onKeyDown={(e) => {
      // The stock input blocks Enter during a turn without a queue; Dispand accepts steering.
      if (running && canSend && e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.currentTarget.closest("form")?.requestSubmit();
      }
    }}
    className={`${tools ? "w-full basis-full" : "flex-[1_1_12rem]"} min-h-11 min-w-0 resize-none bg-transparent px-2 py-2 text-base leading-relaxed sm:text-[15px] outline-none placeholder:text-faint disabled:opacity-60`} />;
  return <div className={`shrink-0 pb-4 pt-2 ${tools ? "px-4" : "bg-surface px-2"}`}>
    {error && <p role="alert" className="mb-2 px-1 text-[13px] text-danger">{error}</p>}
    {waiting && <p className="mx-auto mb-2 max-w-3xl px-1 text-[13px] text-muted">{t(waiting === "proposal" ? "draftWhileWaiting" : "answerAbove")}</p>}
    {queued}
    <ComposerPrimitive.AttachmentDropzone asChild disabled={!open || waiting === "question" || busy}>
    <ComposerPrimitive.Root className={`mx-auto flex w-full max-w-3xl flex-wrap items-end rounded-2xl border border-line bg-surface focus-within:border-accent data-[dragging=true]:border-accent data-[dragging=true]:bg-hover ${tools ? "gap-2 p-3 shadow-sm" : "gap-1 p-2"}`}
      onSubmit={(e) => {
        if (running) { e.preventDefault(); if (canSend) aui.composer().send(); }
      }}>
      <ComposerQuote />
      <div className="flex basis-full flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachment }} />
      </div>
      {assistantAgentId ? <AssistantInput agentId={assistantAgentId} runId={runId} onTextChange={(value) => aui.composer().setText(value)} onSkillChange={chooseSkill} inputProps={{ ...input.props, value: text }} /> : input}
      <div className={`ml-auto flex max-w-full flex-wrap items-center justify-end ${tools ? "w-full gap-2" : "gap-1"}`}>
        {runId && !tools && onNewConversation && <Button type="button" variant="ghost" size="icon-sm" aria-label={t("newConversation")} title={t("newConversation")} className="rounded-full text-muted" disabled={busy} onClick={onNewConversation}><MessageSquarePlus aria-hidden /></Button>}
        <ComposerPrimitive.AddAttachment multiple disabled={!open || waiting === "question" || busy} aria-label={t("attachFile")} title={t("attachFile")} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:opacity-60">
          <Paperclip size={16} aria-hidden />
        </ComposerPrimitive.AddAttachment>
        {tools && <div className="min-w-0 flex-1">{tools}</div>}
        {canStop && <ComposerPrimitive.Cancel asChild><Button type="button" variant="outline" size="icon-sm" aria-label={t("stopResponse")} title={t("stopResponse")} disabled={busy} className="rounded-full"><Square aria-hidden /></Button></ComposerPrimitive.Cancel>}
        {running ? <Button type="submit" size="icon-sm" aria-label={t("send")} disabled={busy || !text.trim() || !canSend} className="rounded-full"><ArrowUp aria-hidden /></Button> :
          <ComposerPrimitive.Send asChild><Button type="button" size="icon-sm" aria-label={t("send")} disabled={!text.trim() || busy || !canSend} className="rounded-full"><ArrowUp aria-hidden /></Button></ComposerPrimitive.Send>}
      </div>
    </ComposerPrimitive.Root>
    </ComposerPrimitive.AttachmentDropzone>
    {!waiting && <p className="mx-auto mt-2 hidden max-w-3xl px-1 text-xs text-faint md:block">{t("hintSend")}</p>}
  </div>;
}
