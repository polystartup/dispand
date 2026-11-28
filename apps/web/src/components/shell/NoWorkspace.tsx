import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { orpc } from "../../lib/api.ts";
import { AuthCard } from "../auth/AuthCard.tsx";
import { UserMenu } from "./UserMenu.tsx";

/** What a person sees when they belong to no workspace (their assignments were removed): the owner to ask in each of their organizations. */
export function NoWorkspace({ user }: Pick<ComponentProps<typeof UserMenu>, "user">) {
  const { t } = useTranslation("shell");
  // Not kept once the screen goes: another account may sign in to this page.
  const contacts = useQuery(orpc.workspace.contacts.queryOptions({ gcTime: 0 }));
  return (
    <AuthCard title={t("noWorkspace.title")} subtitle={t("noWorkspace.subtitle")}>
      <div className="space-y-4">
        {contacts.error && (
          <p role="alert" className="text-[14px] text-danger">
            {t("noWorkspace.failed")}
          </p>
        )}
        {contacts.data?.length === 0 && <p className="text-[15px]">{t("noWorkspace.noOrganization")}</p>}
        {contacts.data?.map(({ organizationId, organizationName, owner }) => (
          <p key={organizationId} className="text-[15px] wrap-anywhere">
            <span className="mb-1.5 block text-[13px] font-medium text-muted">{t("noWorkspace.ask", { organization: organizationName })}</span>
            {owner.name}{" "}
            <a className="text-accent underline" href={`mailto:${owner.email}`}>
              {owner.email}
            </a>
          </p>
        ))}
        <UserMenu user={user} workspace={undefined} />
      </div>
    </AuthCard>
  );
}
