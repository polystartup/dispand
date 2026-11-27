import { ORPCError } from "@orpc/client";
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
          const email = form.get("email") as string;
          const password = form.get("password") as string;
          setBusy(true);
          setError(null);
          let created = false;
          try {
            await api.auth.setup({
              name: form.get("name") as string,
              organizationName: (form.get("organizationName") as string).trim() || undefined,
              workspaceName: (form.get("workspaceName") as string).trim() || undefined,
              email,
              password,
              setupCode: form.get("setupCode") as string,
            });
            created = true;
            await signIn(email, password);
            await navigate({ to: "/" });
          } catch (err) {
            // The owner exists once setup succeeded: retrying would be refused, so go sign in.
            if (created) await navigate({ to: "/login" });
            else {
              // Too many wrong codes: even the right one is refused for a while.
              setError(err instanceof ORPCError && err.code === "TOO_MANY_REQUESTS" ? t("error.tooMany") : t("setup.failed"));
              setBusy(false);
            }
          }
        }}
      >
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the page holds only this form, so focus starts in it */}
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
