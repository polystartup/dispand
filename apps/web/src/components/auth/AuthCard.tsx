import { Workflow } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[380px] animate-[pop_0.3s_ease-out]">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-5 grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground shadow-card" aria-hidden>
            <Workflow size={28} />
          </span>
          <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-[15px] text-muted">{subtitle}</p>
        </div>
        <div className="rounded-2xl bg-surface p-6 shadow-card">{children}</div>
      </div>
    </main>
  );
}

const input =
  "w-full rounded-xl border border-line bg-bg px-3.5 py-2.5 text-[15px] outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/15";

export function Field({ label, ...props }: { label: string } & React.ComponentProps<"input">) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      <input {...props} className={input} />
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  // The form submits through JS: before hydration, a click would post the page and lose the form.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <button
      type="submit"
      disabled={busy || !hydrated}
      className="mt-2 w-full rounded-xl bg-accent py-2.5 text-[15px] font-medium text-accent-foreground transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-[13px] text-danger">
      {message}
    </p>
  ) : null;
}
