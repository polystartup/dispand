import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Empty, List } from "../components/settings/parts.tsx";
import { pluginTabs } from "../components/settings/PluginInstallSheet.tsx";
import { PluginRow } from "../components/settings/PluginRow.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/plugins/installed")({ component: Installed });

function Installed() {
  const { t } = useTranslation("plugins");
  const plugins = useQuery(orpc.plugins.list.queryOptions());
  return (
    <>
      <Tabs tabs={pluginTabs.map((tab) => ({ ...tab, label: t(tab.label) }))} />
      <PageHeader title={t("installedPage.title")} subtitle={t("installedPage.subtitle")} />
      {plugins.error && !plugins.data && (
        <p role="alert" className="text-[14px] text-danger">
          {t("installedPage.failed")}
        </p>
      )}
      {plugins.data?.length === 0 && (
        <Empty title={t("installedPage.emptyTitle")} text={t("installedPage.emptyText")}>
          <Button asChild>
            <Link to="/settings/plugins">{t("installedPage.discover")}</Link>
          </Button>
        </Empty>
      )}
      {plugins.data && plugins.data.length > 0 && (
        <List>
          {plugins.data.map((p) => (
            <PluginRow key={p.id} plugin={p} />
          ))}
        </List>
      )}
    </>
  );
}
