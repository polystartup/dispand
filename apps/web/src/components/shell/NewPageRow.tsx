import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { orpc } from "../../lib/api.ts";

/** "+ New page": opens an inline title input; Enter creates the page and opens it, Escape cancels. */
export function NewPageRow({ className, onNavigate }: { className: string; onNavigate: () => void }) {
  const [title, setTitle] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation(
    orpc.pages.create.mutationOptions({
      onSuccess: async (page) => {
        setTitle(null);
        await queryClient.invalidateQueries({ queryKey: orpc.pages.list.key() });
        onNavigate();
        await navigate({ to: "/p/$pageId", params: { pageId: page.id } });
      },
    }),
  );

  if (title === null) {
    return (
      <button type="button" onClick={() => setTitle("")} className={className}>
        <Plus size={17} className="text-faint" aria-hidden />
        New page
      </button>
    );
  }
  return (
    <div className="px-1 py-0.5">
      <input
        aria-label="New page title"
        autoFocus
        value={title}
        maxLength={100}
        placeholder="Page title"
        disabled={create.isPending}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setTitle(null);
          if (e.key === "Enter" && title.trim() !== "") create.mutate({ title: title.trim() });
        }}
        onBlur={() => !create.isPending && title.trim() === "" && setTitle(null)}
        className="h-8 w-full rounded-lg bg-surface px-2.5 text-[14px] outline-none ring-1 ring-line focus-visible:ring-2 focus-visible:ring-accent"
      />
      {create.error && (
        <p role="alert" className="mt-1 px-1 text-[12px] text-danger">
          {(create.error as { code?: string }).code === "BAD_REQUEST" ? create.error.message : "Could not create the page."}
        </p>
      )}
    </div>
  );
}
