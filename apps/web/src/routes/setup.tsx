import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthCard, Field, FormError, SubmitButton } from "../components/auth/AuthCard.tsx";
import { api } from "../lib/api.ts";
import { signIn } from "../lib/auth-call.ts";
import { getAuthState } from "../server/session.ts";

export const Route = createFileRoute("/setup")({
  beforeLoad: async () => {
    const { needsSetup } = await getAuthState();
    if (!needsSetup) throw redirect({ to: "/login" });
  },
  component: Setup,
});

function Setup() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthCard title="Welcome to Dispand" subtitle="Create the owner account to get started.">
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
              setError("Could not create the account. Check the details and try again.");
              setBusy(false);
            }
          }
        }}
      >
        <Field label="Name" name="name" autoComplete="name" required autoFocus />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        <Field label="Setup code" name="setupCode" autoComplete="off" required />
        <p className="-mt-2 text-[13px] text-muted">Find it in the server's settings as DISPAND_SETUP_CODE.</p>
        <FormError message={error} />
        <SubmitButton busy={busy}>Create account</SubmitButton>
      </form>
    </AuthCard>
  );
}
