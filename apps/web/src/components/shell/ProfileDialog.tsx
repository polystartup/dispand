import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "../../lib/api.ts";

const MAX = 1000;

/** What the person knows and can answer: one text, shown to agents in every workspace they belong to. */
export function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation(["shell", "common"]);
  const queryClient = useQueryClient();
  const current = useQuery({ ...orpc.profile.get.queryOptions(), enabled: open });
  // What is typed, once editing; until then the field shows the saved text.
  const [typed, setTyped] = useState<string | null>(null);
  const save = useMutation(orpc.profile.update.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.profile.get.key() });
      close(false);
    },
  }));
  const close = (next: boolean) => {
    if (!next) {
      setTyped(null);
      save.reset();
    }
    onOpenChange(next);
  };
  const value = typed ?? current.data?.description ?? "";
  // The server trims before it counts.
  const count = value.trim().length;
  const tooLong = count > MAX;
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogTitle>{t("profile.title")}</DialogTitle>
        <DialogDescription>{t("profile.hint")}</DialogDescription>
        <Textarea aria-label={t("profile.title")} value={value} disabled={!current.data} onChange={(e) => setTyped(e.target.value)} aria-invalid={tooLong} rows={6} />
        <p className={`text-right text-[13px] ${tooLong ? "text-danger" : "text-muted"}`}>{t("profile.counter", { used: number.format(count), max: number.format(MAX) })}</p>
        {(current.error ?? save.error) && (
          <p role="alert" className="text-[13px] text-danger">
            {(current.error ?? save.error)!.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">{t("common:actions.cancel")}</Button>
          </DialogClose>
          <Button disabled={!current.data || tooLong || save.isPending} onClick={() => save.mutate({ description: value })}>
            {t("common:actions.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
