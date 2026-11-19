import { AttachmentPrimitive, useAuiState } from "@assistant-ui/react";
import { AlertCircle, FileText, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "../ui/dialog.tsx";

/** Stock attachment primitives; previews come only from our server-validated upload adapter. */
function AttachmentTile({ composer }: { composer: boolean }) {
  const { t } = useTranslation(["chat", "common"]);
  const attachment = useAuiState((s) => s.attachment);
  const uploading = attachment.status.type === "running";
  const failed = attachment.status.type === "incomplete";
  const image = attachment.type === "image" ? attachment.content?.find((part) => part.type === "image") : undefined;
  const src = image?.type === "image" && /^\/files\/[A-Za-z0-9_]{1,64}$/.test(image.image) ? image.image : undefined;
  const tile = "flex min-h-11 max-w-56 items-center gap-2 rounded-lg border border-line bg-surface p-2 text-sm text-muted focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <AttachmentPrimitive.Root className="relative">
      {src ? (
        <Dialog>
          <DialogTrigger className={`${tile} cursor-zoom-in p-0`} aria-label={t("previewFile", { name: attachment.name })}>
            <img src={src} alt={attachment.name} className="size-20 rounded-lg object-cover" />
          </DialogTrigger>
          <DialogContent className="max-w-3xl" aria-describedby={undefined}>
            <DialogTitle className="pr-11 break-words">{attachment.name}</DialogTitle>
            <img src={src} alt={attachment.name} className="mx-auto max-h-[75vh] object-contain" />
            <DialogClose aria-label={t("common:actions.close")} className="absolute right-2 top-2 grid size-11 place-items-center rounded hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"><X size={18} aria-hidden /></DialogClose>
          </DialogContent>
        </Dialog>
      ) : !composer ? (
        <a href={`/files/${encodeURIComponent(attachment.id)}`} download className={tile} aria-label={t("downloadFile", { name: attachment.name })}>
          <FileText size={18} className="shrink-0" aria-hidden /><span className="truncate"><AttachmentPrimitive.Name /></span>
        </a>
      ) : (
        <div className={`${tile} pr-12`}>
          <FileText size={18} className="shrink-0" aria-hidden /><span className="truncate"><AttachmentPrimitive.Name /></span>
        </div>
      )}
      {uploading && <span role="status" className="flex items-center gap-1 text-xs text-muted"><Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />{t("uploadingFile")}</span>}
      {failed && <span role="alert" className="flex items-center gap-1 text-xs text-danger"><AlertCircle size={12} aria-hidden />{t("uploadFailed")}</span>}
      {composer && <AttachmentPrimitive.Remove aria-label={t("removeFile")} title={t("removeFile")} className="absolute right-0 top-0 grid size-11 place-items-center rounded-lg bg-surface text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><X size={14} aria-hidden /></AttachmentPrimitive.Remove>}
    </AttachmentPrimitive.Root>
  );
}

export const ComposerAttachment = () => <AttachmentTile composer />;
export const MessageAttachment = () => <AttachmentTile composer={false} />;
