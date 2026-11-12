import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Empty, List } from "../components/settings/parts.tsx";
import { pluginTabs } from "../components/settings/PluginInstallSheet.tsx";
import { PluginRow } from "../components/settings/PluginRow.tsx";
import { Tabs } from "../components/settings/Tabs.tsx";
import { PageHeader } from "../components/Placeholder.tsx";
import { orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/settings/plugins/installed")({ component: Installed });

function Installed() {
  const plugins = useQuery(orpc.plugins.list.queryOptions());
  return (
    <>
      <Tabs tabs={pluginTabs} />
      <PageHeader title="Installed" subtitle="Plugins you brought in, with what each one added." />
      {plugins.error && !plugins.data && (
        <p role="alert" className="text-[14px] text-danger">
          Could not load the plugins.
        </p>
      )}
      {plugins.data?.length === 0 && (
        <Empty title="No plugin installed" text="Plugins bring skills, tools and agents made by others. Find them in your marketplaces.">
          <Button asChild>
            <Link to="/settings/plugins">Discover plugins</Link>
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
