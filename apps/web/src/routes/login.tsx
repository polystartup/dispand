import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthCard, Field, FormError, SubmitButton } from "../components/auth/AuthCard.tsx";
import { authErrorMessage, signIn } from "../lib/auth-call.ts";

export const Route = createFileRoute("/login")({
  beforeLoad: ({ context }) => {
    const { needsSetup, user } = context.auth;
    if (needsSetup) throw redirect({ to: "/setup" });
    if (user) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthCard title={t("signIn.title")} subtitle={t("signIn.subtitle")}>
      <form
        method="post"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setBusy(true);
          setError(null);
          try {
            await signIn(String(form.get("email")), String(form.get("password")));
            await navigate({ to: "/" });
          } catch (error) {
            setError(authErrorMessage(t, error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("signIn.email")} name="email" type="email" autoComplete="email" required autoFocus />
        <Field label={t("signIn.password")} name="password" type="password" autoComplete="current-password" required />
        <FormError message={error} />
        <SubmitButton busy={busy}>{t("signIn.submit")}</SubmitButton>
      </form>
    </AuthCard>
  );
}
