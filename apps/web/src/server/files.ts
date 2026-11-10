import { openAttachment, type Auth, type Db } from "@dispand/domain";

type FilesApp = { db: Db; auth: Auth; filesDir: string };

/** RFC 5987 `filename*`: every byte but unreserved characters percent-encoded, so no quote or CRLF survives. */
const encodedName = (name: string) => encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `GET /files/<id>`: an attachment, to the owner's session only. Only images sniffed on upload
 * (PNG, JPEG, GIF, WebP) are served inline; everything else, SVG included, is a download. Both
 * get `nosniff` and a sandbox CSP, so even a file opened in a tab runs nothing.
 */
export async function handleFileDownload(request: Request, app: FilesApp): Promise<Response> {
  const session = await app.auth.api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });
  const id = new URL(request.url).pathname.replace(/^\/files\//, "");
  const file = /^[A-Za-z0-9_]{1,64}$/.test(id) ? await openAttachment(app.db, app.filesDir, session.user.id, id) : null;
  if (!file) return new Response(null, { status: 404 });
  const disposition = `${file.image ? "inline" : "attachment"}; filename*=UTF-8''${encodedName(file.name)}`;
  return new Response(file.body, {
    headers: {
      "content-type": file.image ? file.mime : "application/octet-stream",
      "content-length": String(file.size),
      "content-disposition": disposition,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=3600",
    },
  });
}
