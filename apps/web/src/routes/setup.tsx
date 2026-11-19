import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthCard, Field, FormError, SubmitButton } from "../components/auth/AuthCard.tsx";
import { api } from "../lib/api.ts";
import { signIn } from "../lib/auth-call.ts";

export const Route = createFileRoute("/setup")({
  beforeLoad: ({ context }) => {
    const { needsSetup } = context.auth;
    if (!needsSetup) throw redirect({ to: "/login" });
  },
  component: Setup,
});

function Setup() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthCard title={t("setup.title")} subtitle={t("setup.subtitle")}>
      <form
        method="post"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const email = String(form.get("email"));
          const password = String(form.get("password"));
          setBusy(true);
          setError(null);
          let created = false;
          try {
            await api.auth.setup({
              name: String(form.get("name")),
              organizationName: String(form.get("organizationName")).trim() || undefined,
              workspaceName: String(form.get("workspaceName")).trim() || undefined,
              email,
              password,
              setupCode: String(form.get("setupCode")),
            });
            created = true;
            await signIn(email, password);
            await navigate({ to: "/" });
          } catch {
            // The owner exists once setup succeeded: retrying would be refused, so go sign in.
            if (created) await navigate({ to: "/login" });
            else {
              setError(t("setup.failed"));
              setBusy(false);
            }
          }
        }}
      >
        <Field label={t("setup.name")} name="name" autoComplete="name" required autoFocus />
        <Field label={t("setup.email")} name="email" type="email" autoComplete="email" required />
        <Field label={t("setup.password")} name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        <Field label={t("setup.code")} name="setupCode" autoComplete="off" required />
        <p className="-mt-2 text-[13px] text-muted">{t("setup.codeHint")}</p>
        <Field label={t("setup.organizationName")} name="organizationName" maxLength={120} />
        <Field label={t("setup.workspaceName")} name="workspaceName" maxLength={120} />
        <FormError message={error} />
        <SubmitButton busy={busy}>{t("setup.submit")}</SubmitButton>
      </form>
    </AuthCard>
  );
}
