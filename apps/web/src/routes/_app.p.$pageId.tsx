import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageMenu } from "../components/dashboard/PageMenu.tsx";
import { EmptyPage, PageView } from "../components/dashboard/PageView.tsx";
import { api, orpc } from "../lib/api.ts";

export const Route = createFileRoute("/_app/p/$pageId")({ component: Page });

function Page() {
  const { pageId } = Route.useParams();
  const page = useQuery({
    ...orpc.pages.get.queryOptions({ input: { id: pageId } }),
    // A page that doesn't exist won't by retrying.
    retry: (failures, error) => (error as { code?: string }).code !== "NOT_FOUND" && failures < 3,
  });
  if (page.error && !page.data) {
    const gone = (page.error as { code?: string }).code === "NOT_FOUND";
    return (
      <div className="grid place-items-center rounded-2xl bg-surface px-6 py-16 text-center shadow-card">
        <p role="alert" className="text-[17px] font-medium">
          {gone ? "This page doesn't exist" : "Could not load this page."}
        </p>
        <Link to="/" className="mt-2 text-[14px] text-accent hover:underline">
          Go Home
        </Link>
      </div>
    );
  }
  if (!page.data) return null;
  // A new key per page: an edit in progress doesn't follow to the next page.
  return <Loaded key={page.data.id} page={page.data} />;
}

type LoadedPage = Awaited<ReturnType<typeof api.pages.get>>;

function Loaded({ page }: { page: LoadedPage }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState<string | null>(null);
  const rename = useMutation(
    orpc.pages.rename.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.pages.key() }),
      onSettled: () => setTitle(null),
    }),
  );
  function save() {
    const next = title?.trim() ?? "";
    if (next === "" || next === page.title) return setTitle(null);
    rename.mutate({ id: page.id, title: next });
  }

  const heading =
    title === null ? (
      <div className="flex items-center gap-1">
        <h1 className="truncate text-[28px] font-semibold leading-tight tracking-tight">{rename.isPending ? rename.variables.title : page.title}</h1>
        {page.kind === "page" && <PageMenu page={page} onRename={() => setTitle(page.title)} />}
      </div>
    ) : (
      <input
        aria-label="Page title"
        autoFocus
        value={title}
        maxLength={100}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setTitle(null);
        }}
        className="w-full rounded-lg bg-transparent text-[28px] font-semibold leading-tight tracking-tight outline-none ring-accent focus-visible:ring-2"
      />
    );
  return (
    <>
      {rename.isError && (
        <p role="alert" className="mb-4 text-[14px] text-danger">
          Could not rename the page. Try again.
        </p>
      )}
      <PageView page={page} heading={heading} empty={<EmptyPage text="Add a widget to start a workflow from this page." />} />
    </>
  );
}
