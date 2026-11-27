import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { AuthCard } from "../components/auth/AuthCard.tsx";
import { SignInForm } from "../components/auth/SignInForm.tsx";
import { returnPath } from "../lib/return-path.ts";

/** The page sign-in came from (`?redirect`, set by the app's guard) when it is one of this app's, else Home: `href` wins over `to`. */
const back = (from: string | undefined) => ({ to: "/" as const, href: returnPath(from) });

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().max(8000).optional().catch(undefined) }),
  beforeLoad: ({ context, search }) => {
    const { needsSetup, user } = context.auth;
    if (needsSetup) throw redirect({ to: "/setup" });
    if (user) throw redirect(back(search.redirect));
  },
  component: Login,
});

function Login() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const to = Route.useSearch({ select: (search) => search.redirect });
  return (
    <AuthCard title={t("signIn.title")} subtitle={t("signIn.subtitle")}>
      <SignInForm onSuccess={() => navigate(back(to))} />
    </AuthCard>
  );
}
