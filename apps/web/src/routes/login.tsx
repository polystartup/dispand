import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard, Field, FormError, SubmitButton } from "../components/auth/AuthCard.tsx";
import { authErrorMessage, signIn } from "../lib/auth-call.ts";
import { getAuthState } from "../server/session.ts";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const { needsSetup, user } = await getAuthState();
    if (needsSetup) throw redirect({ to: "/setup" });
    if (user) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthCard title="Sign in" subtitle="Welcome back to Dispand.">
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
            setError(authErrorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <FormError message={error} />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
    </AuthCard>
  );
}
