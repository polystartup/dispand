import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { orpc } from "../../lib/api.ts";
import { useFormat } from "../../lib/format.ts";
import { List } from "./parts.tsx";

/**
 * The people the organization deleted, for its owner: each is kept until the purge deletes them
 * for good on the date shown, and can be restored until then.
 */
export function DeletedPeople() {
  const { t } = useTranslation("settings");
  const format = useFormat();
  const client = useQueryClient();
  const archived = useQuery(orpc.organization.archived.queryOptions({ retry: false }));
  const status = useRef<HTMLParagraphElement>(null);
  const [name, setName] = useState("");
  const restore = useMutation(orpc.organization.restoreMember.mutationOptions({
    onSuccess: () => client.invalidateQueries({ queryKey: orpc.organization.archived.key() }),
  }));
  if (archived.isError) return <p role="alert" className="mt-8">{t("deletedPeople.loadFailed")}</p>;
  if (!archived.data) return null;
  return (
    <section aria-labelledby="deleted-people" className="mt-8">
      <h2 id="deleted-people" className="text-[17px] font-medium tracking-tight">{t("deletedPeople.title")}</h2>
      <p className="mb-3 text-[13px] text-muted">{t("deletedPeople.text")}</p>
      {archived.data.length === 0 ? <p className="text-sm text-muted">{t("deletedPeople.empty")}</p> : (
        <List>
          {archived.data.map((person) => (
            <li key={person.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
              <div className="min-w-0 flex-1 basis-40">
                <p className="break-words text-[15px] font-medium">{person.name}</p>
                <p className="break-all text-[13px] text-muted">{person.email}</p>
                <p className="text-[13px] text-muted">{t("deletedPeople.purgeOn", { date: format.dateTime(person.purgeAfter) })}</p>
              </div>
              <Button size="sm" variant="outline" disabled={restore.isPending} aria-label={t("deletedPeople.restorePerson", { name: person.name })} onClick={() => {
                setName(person.name);
                status.current?.focus();
                restore.mutate({ userId: person.userId });
              }}>{t("deletedPeople.restore")}</Button>
            </li>
          ))}
        </List>
      )}
      {restore.isError && <p role="alert" className="mt-3 text-sm text-danger">{restore.error.message}</p>}
      <p ref={status} tabIndex={-1} role="status" className="mt-3 text-sm text-muted">
        {restore.isPending ? t("deletedPeople.restoring", { name }) : restore.isSuccess && t("deletedPeople.restored", { name })}
      </p>
    </section>
  );
}
