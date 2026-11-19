import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, FormError, SubmitButton } from "./AuthCard.tsx";
import { authErrorMessage, signIn } from "../../lib/auth-call.ts";

export function SignInForm({ onSuccess }: { onSuccess: () => Promise<void> | void }) {
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
      <Field label={t("signIn.email")} name="email" type="email" autoComplete="email" required autoFocus />
      <Field label={t("signIn.password")} name="password" type="password" autoComplete="current-password" required />
      <FormError message={error} />
      <SubmitButton busy={busy}>{t("signIn.submit")}</SubmitButton>
    </form>
  );
}
