import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The shared look of a settings list: one rounded card of rows. */
export function List({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-surface shadow-card">{children}</ul>;
}

export function Empty({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-2xl bg-surface px-6 py-16 text-center shadow-card">
      <p className="text-[17px] font-medium">{title}</p>
      <p className="mb-5 mt-1 max-w-sm text-[14px] text-muted">{text}</p>
      {children}
    </div>
  );
}

const statusLabels = { online: "Online", offline: "Offline", outdated: "Needs an update" };

export function StatusDot({ status }: { status: keyof typeof statusLabels }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
      <span aria-hidden className={cn("size-2 rounded-full", status === "online" ? "bg-[#30d158]" : status === "outdated" ? "bg-danger" : "bg-faint")} />
      {statusLabels[status]}
    </span>
  );
}

/** For each runner too old to connect: the command that updates it on its machine. */
export function OutdatedRunners({ runners }: { runners: { id: string; name: string; status: string; updateCommand?: string; runnerUpdate?: string }[] }) {
  return runners
    .filter((r) => r.status === "outdated" && !["available", "updating", "current"].includes(r.runnerUpdate ?? ""))
    .map((r) => (
      <section key={r.id} role="status" className="mb-4 space-y-2 rounded-xl border border-line p-4">
        <p className="text-[14px]">
          The runner {r.name} needs an update before it can connect. Run this on its machine (its pairing and settings are kept):
        </p>
        <pre
          aria-label={`Update command for ${r.name}`}
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px]"
        >
          {r.updateCommand}
        </pre>
      </section>
    ));
}

export function FormField({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[12px] text-faint">{hint}</p>}
    </div>
  );
}

/** A banner with a call to action, for what to do next. */
export function NextStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface px-5 py-4 shadow-card">
      <p className="text-[15px] font-medium">{title}</p>
      {children}
    </div>
  );
}

/**
 * Room for one banner (NextStep's height), kept even while it is empty: banners that come and
 * go with each save don't move the content below them.
 */
export function BannerSlot({ children }: { children?: ReactNode }) {
  // 104 px: on narrow screens the banner wraps its button below the text.
  return <div className="mb-6 min-h-[104px] sm:min-h-[68px] [&>*]:mb-0">{children}</div>;
}
