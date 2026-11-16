import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Placeholder } from "../components/Placeholder.tsx";

export const Route = createFileRoute("/_app/help")({ component: Help });

function Help() {
  const { t } = useTranslation("dashboard");
  return <Placeholder title={t("help.title")} subtitle={t("help.subtitle")} />;
}
