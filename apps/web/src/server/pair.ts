import { pair, PairingRefused, type Db } from "@dispand/domain";
import { z } from "zod";

/** `{ code }` is a few dozen bytes: anything past this is refused unread. */
export const MAX_PAIR_BODY_BYTES = 1024;

const Body = z.object({ code: z.string().min(1).max(64) });

/** Reads at most `max` bytes of the body (chunked or not), or null once it has more. */
async function readLimited(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * `POST /runner/pair` with `{ code }`. Public on purpose: the runner has no session yet. Unknown,
 * used and expired codes get the same 401.
 */
export async function handlePair(request: Request, db: Db): Promise<Response> {
  const text = await readLimited(request, MAX_PAIR_BODY_BYTES);
  if (text === null) return Response.json({ error: "Body too large" }, { status: 413 });
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Answered as a bad body below.
  }
  const body = Body.safeParse(json);
  if (!body.success) return Response.json({ error: "Expected { code }" }, { status: 400 });
  try {
    return Response.json(await pair(db, body.data.code), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof PairingRefused) return Response.json({ error: "Invalid pairing code" }, { status: 401 });
    throw err;
  }
}
