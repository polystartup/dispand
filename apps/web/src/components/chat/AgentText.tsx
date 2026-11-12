import { MarkdownTextPrimitive, type CodeHeaderProps } from "@assistant-ui/react-markdown";
import { useRouter } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Check, Copy } from "lucide-react";

// Text an agent wrote, shown formatted. Whatever it holds, the browser is not made to fetch
// anything from elsewhere: an image shows only when it is one of the app's own files, a link is a
// button that says where it goes and opens on a click (a page of the app's, in the app), and raw
// HTML is not rendered at all. The
// page's Content-Security-Policy is the second line behind this one.

/** The app's own files, by id: no scheme, no host, no `..`. */
const FILE = /^\/files\/[A-Za-z0-9_-]{1,64}$/;
/** Where a link may go when clicked. */
const LINK = /^(https?:|mailto:)/i;

/**
 * A page of the app (a tool's `signInPath`): a path from the root with one `/`, without `.` or
 * `..` segments or a backslash, so it can't name another host or climb out of the path it reads as.
 */
export function isAppPath(url: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\")) return false;
  const path = url.split(/[?#]/)[0]!;
  return path.split("/").every((segment) => segment !== "." && segment !== ".." && !/%2e/i.test(segment) && !/%2f|%5c/i.test(segment));
}

function urlTransform(url: string, key: string): string | null {
  if (key === "src") return FILE.test(url) ? url : null;
  if (key === "href") return LINK.test(url) || isAppPath(url) ? url : null;
  return null;
}

/** A link to a page of the app: it navigates in the app, in place, on a click. */
function AppLink({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  return (
    <button type="button" title={href} className="text-left text-accent underline" onClick={() => (router ? void router.navigate({ href }) : window.location.assign(href))}>
      {children}
    </button>
  );
}

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setError(false);
    } catch {
      setError(true);
    }
  }
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-t-lg border border-line bg-surface px-3 py-2 text-[12px] text-muted">
      <span className="min-w-0 truncate font-mono">{language || "Code"}</span>
      <button type="button" onClick={() => void copy()} aria-label="Copy code" className="flex shrink-0 items-center gap-1.5 rounded px-1 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
        {copied === code ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        <span role="status">{error ? "Copy failed; try again" : copied === code ? "Copied" : "Copy code"}</span>
      </button>
    </div>
  );
}

const components: ComponentProps<typeof MarkdownTextPrimitive>["components"] = {
  CodeHeader,
  img: ({ src, alt }) =>
    typeof src === "string" && FILE.test(src) ? <img src={src} alt={alt ?? ""} className="my-1 max-h-64 rounded-lg" /> : <span className="text-faint">[image not shown: {alt || "no description"}]</span>,
  a: ({ href, children }) =>
    typeof href === "string" && isAppPath(href) ? (
      <AppLink href={href}>{children}</AppLink>
    ) : typeof href === "string" && LINK.test(href) ? (
      <button type="button" title={href} className="text-left text-accent underline" onClick={() => window.open(href, "_blank", "noopener,noreferrer")}>
        {children} <span className="text-[12px] text-faint no-underline">({href})</span>
      </button>
    ) : (
      <span>{children}</span>
    ),
};

const prose =
  "min-w-0 w-full break-words text-[15px] leading-relaxed text-fg " +
  "[&_p]:whitespace-pre-wrap [&_p+p]:mt-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_h1]:mt-1 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h2]:mt-1 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h3]:mt-1 [&_h3]:font-semibold " +
  "[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_pre]:mb-3 [&_pre]:mt-0 [&_pre]:overflow-x-auto [&_pre]:rounded-b-lg [&_pre]:border [&_pre]:border-t-0 [&_pre]:border-line [&_pre]:bg-surface [&_pre]:p-2 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted";

/** An agent's words in the conversation. */
export function AgentText() {
  return (
    <div className="flex min-w-0 justify-start">
      <div className={prose}>
        <MarkdownTextPrimitive smooth={false} skipHtml urlTransform={urlTransform} components={components} />
      </div>
    </div>
  );
}
