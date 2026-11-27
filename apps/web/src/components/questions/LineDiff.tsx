import { useTranslation } from "react-i18next";
import type { DiffLine } from "../../lib/line-diff.ts";

/** A change to an agent's text: every line, only the lines that changed marked. */
export function LineDiff({ lines }: { lines: DiffLine[] }) {
  const { t } = useTranslation("questions");
  return (
    <div className="rounded-lg bg-hover p-2 font-sans text-[13px]">
      {lines.map((l, i) => (
        <div key={i} data-change={l.kind} className={`whitespace-pre-wrap break-words before:mr-1.5 before:select-none ${l.kind === "add" ? "bg-green-500/15 before:content-['+']" : l.kind === "del" ? "bg-red-500/15 line-through before:content-['−']" : "text-muted before:content-['_'] before:invisible"}`}>
          {l.kind !== "same" && <span className="sr-only">{t(l.kind === "add" ? "proposal.added" : "proposal.removed")}</span>}
          {l.line}
        </div>
      ))}
    </div>
  );
}
