import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, MessageSquarePlus, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AssistantInput } from "../assistant/AssistantInput.tsx";
import { ChatInput, ComposerAttachments, ComposerQuote } from "./Thread.tsx";

type Props = {
  runId: string | null;
  assistantAgentId?: string;
  tools?: ReactNode;
  open: boolean;
  asking: boolean;
  approval: boolean;
  busy: boolean;
  error: string | null;
  onNewConversation?: () => void;
  onApprove: () => Promise<boolean>;
  onDecline: (message: string) => Promise<boolean>;
};

/** Standard composer primitives, with Dispand's explicit proposal-answering controls. */
export function ChatComposer({ runId, assistantAgentId, tools, open, asking, approval, busy, error, onNewConversation, onApprove, onDecline }: Props) {
  const { t } = useTranslation("chat");
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  function chooseSkill(entry: { name: string; skillId?: string }) {
    const config = aui.composer().getState().runConfig;
    aui.composer().setRunConfig({ ...config, custom: { ...config.custom, skill: entry } });
  }
  async function decline() {
    const submitted = aui.composer().getState().text;
    if (!submitted.trim() || busy) return;
    if (await onDecline(submitted.trim())) {
      if (aui.composer().getState().text === submitted) aui.composer().setText("");
    }
  }
  const input = <ChatInput aria-label={t("message")} minRows={1} disabled={!open || asking}
    placeholder={!open ? t("over") : approval ? t("approvalPlaceholder") : t("message")}
    onKeyDown={(e) => {
      if (approval && e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && !text.trim()) {
        e.preventDefault();
        void onApprove();
      }
    }}
    className={`${tools ? "w-full basis-full" : "flex-1"} min-h-9 min-w-0 resize-none bg-transparent px-2 py-[7px] text-[15px] leading-5 outline-none placeholder:text-faint disabled:opacity-60`} />;
  return <div className={`shrink-0 px-4 pb-4 pt-2 ${tools ? "" : "bg-surface"}`}>
    {error && <p role="alert" className="mb-2 px-1 text-[13px] text-danger">{error}</p>}
    {asking && <p className="mb-2 px-1 text-[13px] text-muted">{t("answerAbove")}</p>}
    {approval && open && <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-1">
      <Button type="button" size="sm" disabled={busy} onClick={() => void onApprove()} className="rounded-full"><ShieldCheck aria-hidden />{t("approve")}</Button>
      <span className="text-[13px] text-muted">{t("approveHint")}</span>
    </div>}
    <ComposerPrimitive.AttachmentDropzone asChild disabled={!open || asking || approval || busy}>
    <ComposerPrimitive.Root className={`mx-auto flex w-full max-w-3xl flex-wrap items-end gap-2 rounded-2xl border border-line p-3 focus-within:border-accent data-[dragging=true]:border-accent data-[dragging=true]:bg-hover ${tools ? "bg-surface/85 shadow-sm backdrop-blur-xl" : "bg-surface"}`}
      onSubmit={(e) => { if (approval) { e.preventDefault(); void decline(); } }}>
      {runId && !tools && onNewConversation && <Button type="button" variant="ghost" size="icon-sm" aria-label={t("newConversation")} title={t("newConversation")} className="rounded-full text-muted" disabled={busy} onClick={onNewConversation}><MessageSquarePlus aria-hidden /></Button>}
      {!approval && <ComposerQuote />}
      <ComposerAttachments hidden={approval} disabled={!open || asking || busy} />
      {assistantAgentId ? <AssistantInput agentId={assistantAgentId} runId={runId} onTextChange={(value) => aui.composer().setText(value)} onSkillChange={chooseSkill} inputProps={{ ...input.props, value: text }} /> : input}
      {tools && <div className="min-w-0 flex-1">{tools}</div>}
      {approval ? <Button type="submit" size="icon-sm" aria-label={t("send")} disabled={busy || !text.trim()} className="rounded-full"><ArrowUp aria-hidden /></Button> :
        <ComposerPrimitive.Send asChild><Button type="button" size="icon-sm" aria-label={t("send")} disabled={!text.trim() || busy} className="rounded-full"><ArrowUp aria-hidden /></Button></ComposerPrimitive.Send>}
    </ComposerPrimitive.Root>
    </ComposerPrimitive.AttachmentDropzone>
    <p className="mx-auto mt-2 hidden max-w-3xl px-1 text-[11px] text-faint md:block">{approval ? t("hintApproval", { mod: MOD }) : t("hintSend")}</p>
  </div>;
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
