import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthCard, Field, FormError, SubmitButton } from "../components/auth/AuthCard.tsx";
import { SignInForm } from "../components/auth/SignInForm.tsx";
import { api } from "../lib/api.ts";
import { signIn, signOut } from "../lib/auth-call.ts";

const secondary = "mt-4 text-sm font-medium text-accent hover:underline";
type Preview = Awaited<ReturnType<typeof api.workspace.invitation>>;

function Details({ preview }: { preview: Preview }) {
  const { t } = useTranslation("auth");
  const details = [
    [t("invitation.inviter"), preview.inviterName],
    [t("invitation.organization"), preview.organizationName],
    [t("invitation.workspace"), preview.workspaceName],
    [t("invitation.role"), t(`invitation.${preview.role}`)],
  ];
  return <dl className="mb-5 grid gap-3">{details.map(([label, value]) =>
    <div key={label}><dt className="text-sm text-muted">{label}</dt><dd className="break-words font-medium">{value}</dd></div>
  )}</dl>;
}

/** `enrollsAccounts`: whether this server makes accounts (`auth.status`); without it, only sign-in is offered. */
export function Recipient({ token, email, enrollsAccounts, refresh }: { token: string | null; email: string | null; enrollsAccounts: boolean; refresh: () => void }) {
  const { t } = useTranslation("auth");
  const [register, setRegister] = useState(false);
  const [address, setAddress] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = token !== null && /^[A-Za-z0-9_-]{43}$/.test(token);
  const preview = useQuery({
    queryKey: ["invitation", token, email, address],
    queryFn: () => email ? api.workspace.invitation({ token: token! }) : api.workspace.registrationPreview({ token: token!, email: address }),
    enabled: valid && !accepted && Boolean(email || address),
    retry: false,
    gcTime: 0,
  });

  function changeMode(wantRegistration: boolean) {
    setRegister(wantRegistration);
    setAddress("");
    setError(null);
  }

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.other"));
    } finally {
      setBusy(false);
    }
  }

  function content() {
    if (token === null) return <p role="status">{t("invitation.loading")}</p>;
    if (!valid) return <FormError message={t("invitation.invalid")} />;
    if (accepted) return <>
      <p role="status">{t("invitation.accepted")}</p>
      {needsLogin ? <>
        <p className="my-3 text-sm text-muted">{t("invitation.signInAgain")}</p>
        <SignInForm email={address} onSuccess={() => setNeedsLogin(false)} />
      </> : <p className="mt-2 text-sm text-muted">{t("invitation.next")}</p>}
    </>;
    if (!email && !register) return <>
      <SignInForm invitation={token} onSuccess={refresh} />
      {enrollsAccounts && <button className={secondary} type="button" onClick={() => changeMode(true)}>{t("invitation.create")}</button>}
    </>;
    if (!email && !address) return <>
      <form className="space-y-4" method="post" onSubmit={event => {
        event.preventDefault();
        setAddress(String(new FormData(event.currentTarget).get("email")).trim());
      }}>
        <Field label={t("signIn.email")} name="email" type="email" autoComplete="email" required autoFocus />
        <SubmitButton busy={false}>{t("invitation.review")}</SubmitButton>
      </form>
      <button className={secondary} type="button" onClick={() => changeMode(false)}>{t("signIn.submit")}</button>
    </>;
    return <>
      {preview.isPending && <p role="status">{t("invitation.loading")}</p>}
      {preview.isError && <FormError message={preview.error.message} />}
      {preview.isSuccess && <>
        <Details preview={preview.data} />
        <form className="space-y-4" method="post" onSubmit={event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void act(async () => {
            if (email) await api.workspace.acceptInvitation({ token });
            else {
              const password = String(form.get("password"));
              await api.workspace.registerInvitation({ token, email: address, name: String(form.get("name")), password });
              // Registration consumed the link. Retry only sign-in if it fails.
              try { await signIn(address, password); } catch { setNeedsLogin(true); }
            }
            setAccepted(true);
          });
        }}>
          {!email && <>
            <Field label={t("setup.name")} name="name" autoComplete="name" required maxLength={200} />
            <Field label={t("setup.password")} name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
          </>}
          <SubmitButton busy={busy}>{t(email ? "invitation.accept" : "invitation.createAccept")}</SubmitButton>
        </form>
      </>}
      <FormError message={error} />
      {email ? <button className={secondary} type="button" disabled={busy} onClick={() => void act(async () => { await signOut(); refresh(); })}>{t("invitation.switch")}</button> :
        <button className={secondary} type="button" disabled={busy} onClick={() => changeMode(false)}>{t("signIn.submit")}</button>}
    </>;
  }

  return <AuthCard title={t("invitation.title")} subtitle={email ? t("invitation.as", { email }) : t("invitation.subtitle")}>{content()}</AuthCard>;
}
