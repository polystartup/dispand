import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "../../lib/api.ts";
import { refusal } from "../../lib/refusal.ts";
import { lineDiff } from "../../lib/line-diff.ts";
import { LineDiff } from "../questions/ProposalItems.tsx";

export type NativeEntry = { key: string; kind: "hook" | "server" | "file" | "unreadable" | "declaration" | "instructions"; label: string; text: string | null };

/**
 * What a plugin's native revision runs in the conversations it is granted to: its hooks, its
 * servers' launches and the files they run. With `before` (the pinned revision), each entry shows
 * what changed. Approving the screen approves exactly this.
 */
export function RunsNatively({ after, before }: { after: NativeEntry[]; before?: NativeEntry[] }) {
  const { t } = useTranslation("plugins");
  const keys = [...new Set([...after.map((e) => e.key), ...(before ?? []).map((e) => e.key)])].sort();
  if (!keys.length) return null;
  return (
    <section aria-labelledby="runs-natively" className="space-y-2">
      <h3 id="runs-natively" className="text-[13px] font-medium text-muted">
        {t("native.title")}
      </h3>
      <p className="text-[13px] text-muted">{t("native.description")}</p>
      <ul className="space-y-3">
        {keys.map((key) => {
          const now = after.find((e) => e.key === key);
          const was = before?.find((e) => e.key === key);
          const entry = (now ?? was)!;
          // Against the pinned revision (when there is one): gone, new, or changed.
          const removed = !!before && !now;
          const added = !!before && !was;
          const changed = !!before && !!now && !!was && was.text !== now.text;
          const diff = changed && was.text != null && now.text != null ? lineDiff(was.text, now.text) : null;
          return (
            <li key={key} className="space-y-1">
              <p className="text-[13px]">
                <span className="text-muted">{t(`native.kind.${entry.kind}`)} </span>
                <span className="font-mono">{entry.label}</span>
                {(removed || added || changed) && <span className="ml-1.5 text-muted">({t(removed ? "native.removed" : added ? "native.added" : "native.changed")})</span>}
              </p>
              {entry.kind === "unreadable" ? (
                <p className="text-[13px] text-muted">{t("native.unreadable")}</p>
              ) : entry.kind === "declaration" ? (
                <p className="text-[13px] text-muted">{t("native.declarationChanged")}</p>
              ) : entry.kind === "instructions" ? (
                <p className="text-[13px] text-muted">{t("native.instructionsChanged")}</p>
              ) : diff ? (
                <LineDiff lines={diff} />
              ) : (
                <pre className={`overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-hover p-2 text-[12px] ${removed ? "line-through" : ""}`}>{(now ?? was)!.text ?? ""}</pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export type NativePreview = Awaited<ReturnType<typeof api.plugins.nativePreview>>;

/** Approving a plugin's current commit for native execution: what it runs, against the pinned revision, then Approve. Mount it only while open. */
export function NativeApproveSheet({ id, name, preview, onClose, onApproved }: { id: string; name: string; preview: NativePreview; onClose: () => void; onApproved: () => void }) {
  const { t } = useTranslation("plugins");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api.plugins.approveNative({ id, sha: preview.sha, reviewed: preview.reviewed });
      onApproved();
      onClose();
    } catch (e) {
      setError(refusal(e, t("approveNative.failed")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-surface sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle className="text-[20px] tracking-tight">{t("approveNative.title", { name })}</SheetTitle>
          <SheetDescription>{t("approveNative.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-6">
          <RunsNatively before={preview.runsNatively.before} after={preview.runsNatively.after} />
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={() => void approve()}>
              {busy ? t("approveNative.approving") : t("approveNative.submit")}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t("approveNative.cancel")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
