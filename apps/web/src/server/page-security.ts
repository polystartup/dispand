/**
 * What every page of the app is served with. Text an agent wrote is shown in many places (chats,
 * the Inbox, transcripts): whatever a renderer makes of it, the browser loads images, media and
 * fonts from the app's own origin only, connects nowhere else, and frames nothing. The one worker
 * it registers is its own service worker (`/sw.js`, Web Push). Scripts and stylesheets come from
 * the app's own origin or inline (its pages need their inline ones). A generated artifact's
 * `srcdoc` frame inherits this policy, so it holds even where the frame's own policy fails.
 */
export const PAGE_CSP = [
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Adds the page policy to an HTML response that has none of its own (a served file keeps its sandbox). */
export function withPageSecurity(response: Response): Response {
  if (!response.headers.get("content-type")?.startsWith("text/html") || response.headers.has("content-security-policy")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", PAGE_CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
