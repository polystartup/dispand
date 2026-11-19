import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, FormError, SubmitButton } from "./AuthCard.tsx";
import { authErrorMessage, signIn } from "../../lib/auth-call.ts";

export function SignInForm({ email, onSuccess }: { email?: string; onSuccess: () => Promise<void> | void }) {
  const { t } = useTranslation("auth");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
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
          await onSuccess();
        } catch (error) {
          setError(authErrorMessage(t, error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label={t("signIn.email")} name="email" type="email" autoComplete="email" defaultValue={email} readOnly={!!email} required autoFocus={!email} />
      <Field label={t("signIn.password")} name="password" type="password" autoComplete="current-password" required autoFocus={!!email} />
      <FormError message={error} />
      <SubmitButton busy={busy}>{t("signIn.submit")}</SubmitButton>
    </form>
  );
}
