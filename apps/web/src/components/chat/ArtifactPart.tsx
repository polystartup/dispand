import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import type { ArtifactRef } from "@dispand/domain/messages/record-result.ts";
import { useQuery } from "@tanstack/react-query";
import { useWidget } from "generative-frame/react";
import { Code, Play } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";

// A generated artifact in the chat. Nothing of its code is rendered as HTML before the owner
// clicks Run: a frame, even a script-less one, could still reach outside (SECURITY.md). After Run
// it runs in an opaque-origin `srcdoc` frame (Generative Frame), under the frame's own policy and
// the page's, which the frame inherits. Its bridge: no tools, prompts only into the draft, https
// links only after the owner confirms them.

/** Puts an artifact's prompt in the composer's draft, which the owner still sends; absent where there is no composer. */
export const DraftPrompt = createContext<((text: string) => void) | undefined>(undefined);

export const ArtifactPart: ToolCallMessagePartComponent<Record<string, never>, ArtifactRef> = ({ result }) => {
  const { t } = useTranslation(["chat", "common"]);
  const format = useFormat();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [failed, setFailed] = useState(false);
  const artifact = useQuery({ ...orpc.artifacts.get.queryOptions({ input: { id: result?.artifactId ?? "" } }), enabled: !!result && (running || showCode), staleTime: Infinity });
  if (!result) return null;
  const code = artifact.data?.code;
  return (
    <section aria-label={result.title} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-medium">{result.title}</p>
          <p className="text-muted">{result.format.toUpperCase()} · {format.size(result.size)}</p>
        </div>
        {!running && <Button size="sm" onClick={() => setConfirming(true)}><Play aria-hidden />{t("artifactRun")}</Button>}
        <Button size="sm" variant="outline" aria-expanded={showCode} onClick={() => setShowCode(!showCode)}><Code aria-hidden />{t(showCode ? "artifactHideCode" : "artifactShowCode")}</Button>
      </div>
      {running && code !== undefined && <ArtifactFrame code={code} onFailed={() => setFailed(true)} />}
      {artifact.isError && <p role="alert" className="text-danger">{t("artifactLoadFailed")}</p>}
      {failed && <p role="status" className="text-muted">{t("artifactFailed")}</p>}
      {/* Literal text: React writes it as a text node, so the markup creates no element. */}
      {showCode && code !== undefined && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-hover p-3 font-mono text-[12px]">{code}</pre>}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>{t("artifactRunTitle")}</DialogTitle>
          <DialogDescription>{t("artifactRunWarning")}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>{t("common:actions.cancel")}</Button>
            {/* Not remembered: a reload shows the card again, and Run asks again. */}
            <Button onClick={() => { setConfirming(false); setRunning(true); }}>{t("artifactRun")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
};

function ArtifactFrame({ code, onFailed }: { code: string; onFailed: () => void }) {
  const { t } = useTranslation(["chat", "common"]);
  const prompt = useContext(DraftPrompt);
  const [link, setLink] = useState<string | null>(null);
  const { ref, widget } = useWidget({
    opaqueOrigin: true,
    // Self-contained: no CDN, no connections, no nested frames, no eval.
    csp: { cdnOrigins: [] },
    maxHeight: 480,
    ...(prompt ? { onPrompt: prompt } : {}),
    onOpenLink: (url) => {
      // The address the owner reads stays the one Open opens: a later request waits for the dialog to close.
      if (new URL(url).protocol === "https:") setLink((shown) => shown ?? url);
    },
    onError: onFailed,
  });
  useEffect(() => {
    // A frame runs its code once: a second effect run on the same frame must not write it again.
    if (!widget || widget.ended) return;
    widget.write(code);
    widget.end().then((end) => end.blank && onFailed(), onFailed);
  }, [widget, code, onFailed]);
  return (
    <>
      {/* The frame's default text is dark (Generative Frame's light theme): a light ground keeps it readable in dark mode until the theme is passed. */}
      <div ref={ref} className="min-w-0 rounded-lg bg-white" />
      <Dialog open={link !== null} onOpenChange={(open) => !open && setLink(null)}>
        <DialogContent>
          <DialogTitle>{t("artifactLinkTitle")}</DialogTitle>
          <DialogDescription>{t("artifactLinkText")}</DialogDescription>
          <p className="break-all font-mono text-[13px]">{link}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLink(null)}>{t("common:actions.cancel")}</Button>
            <Button onClick={() => { window.open(link!, "_blank", "noopener,noreferrer"); setLink(null); }}>{t("artifactOpen")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
