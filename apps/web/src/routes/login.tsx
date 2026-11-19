import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuthCard } from "../components/auth/AuthCard.tsx";
import { SignInForm } from "../components/auth/SignInForm.tsx";

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
  return (
    <AuthCard title={t("signIn.title")} subtitle={t("signIn.subtitle")}>
      <SignInForm onSuccess={() => navigate({ to: "/" })} />
    </AuthCard>
  );
}
