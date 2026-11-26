import shell from "#web-shell";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, FormError, SubmitButton } from "./AuthCard.tsx";
import { ShellPlace, useShellText } from "../shell/ShellPlace.tsx";
import { authErrorMessage, signIn } from "../../lib/auth-call.ts";

type SignInFormProps = { email?: string; onSuccess: () => Promise<void> | void; invitation?: string };

/**
 * The sign-in form, or the build's shell's sign-in in its place (`signIn`), which gets the
 * invitation's token and finishes its own navigation. A shell's sign-in that fails shows a
 * retryable error, never the form it replaced.
 */
export function SignInForm(props: SignInFormProps) {
  const { signIn: Place } = shell;
  return Place ? <ShellSignIn Place={Place} invitation={props.invitation ?? null} /> : <PasswordSignIn {...props} />;
}

function ShellSignIn({ Place, invitation }: { Place: NonNullable<typeof shell.signIn>; invitation: string | null }) {
  const { t } = useTranslation("auth");
  const text = useShellText();
  return (
    <ShellPlace
      fallback={(retry) => (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-danger">{t("signIn.shellFailed")}</p>
          <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={retry}>
            {t("signIn.retry")}
          </button>
        </div>
      )}
    >
      <Place invitation={invitation} t={text} />
    </ShellPlace>
  );
}

function PasswordSignIn({ email, onSuccess }: SignInFormProps) {
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
