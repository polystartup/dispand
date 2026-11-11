import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { ComponentProps } from "react";

// Text an agent wrote, shown formatted. Whatever it holds, the browser is not made to fetch
// anything from elsewhere: an image shows only when it is one of the app's own files, a link is a
// button that says where it goes and opens on a click, and raw HTML is not rendered at all. The
// page's Content-Security-Policy is the second line behind this one.

/** The app's own files, by id: no scheme, no host, no `..`. */
const FILE = /^\/files\/[A-Za-z0-9_-]{1,64}$/;
/** Where a link may go when clicked. */
const LINK = /^(https?:|mailto:)/i;

function urlTransform(url: string, key: string): string | null {
  if (key === "src") return FILE.test(url) ? url : null;
  if (key === "href") return LINK.test(url) ? url : null;
  return null;
}

const components: ComponentProps<typeof MarkdownTextPrimitive>["components"] = {
  img: ({ src, alt }) =>
    typeof src === "string" && FILE.test(src) ? <img src={src} alt={alt ?? ""} className="my-1 max-h-64 rounded-lg" /> : <span className="text-faint">[image not shown: {alt || "no description"}]</span>,
  a: ({ href, children }) =>
    typeof href === "string" && LINK.test(href) ? (
      <button type="button" title={href} className="text-left text-accent underline" onClick={() => window.open(href, "_blank", "noopener,noreferrer")}>
        {children} <span className="text-[12px] text-faint no-underline">({href})</span>
      </button>
    ) : (
      <span>{children}</span>
    ),
};

const prose =
  "max-w-[85%] break-words rounded-[18px] rounded-bl-md bg-hover px-3.5 py-2 text-[15px] leading-snug text-fg " +
  "[&_p]:whitespace-pre-wrap [&_p+p]:mt-2 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_h1]:mt-1 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h2]:mt-1 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h3]:mt-1 [&_h3]:font-semibold " +
  "[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface [&_pre]:p-2 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted";

/** An agent's words in the conversation. */
export function AgentText() {
  return (
    <div className="flex justify-start">
      <div className={prose}>
        <MarkdownTextPrimitive smooth={false} skipHtml urlTransform={urlTransform} components={components} />
      </div>
    </div>
  );
}
