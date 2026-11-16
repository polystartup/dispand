import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { tools as toolsTable } from "../db/schema.ts";
import { errorKind, logError } from "../log.ts";
import { secretAad, type SecretBox } from "../secrets.ts";
import { inSpan, meter, tracer } from "../telemetry/index.ts";
import { headerAad } from "./procedures.ts";

const traces = tracer("tools");
const counts = meter("tools");

/**
 * At server start: a header sealed before headers were bound to their tool's origin (its AAD
 * without one) is sealed again with the origin the tool calls now. Not a SQL migration: it needs
 * the secret key. A header that already opens is left as it is, so a later start changes nothing;
 * one that opens neither way (another key) stays, and fails at use as before. A failure is logged
 * and doesn't stop the server.
 */
export async function resealToolHeaders(db: Db, secrets: SecretBox): Promise<{ resealed: number }> {
  return inSpan(traces, "tools.reseal_headers", {}, errorKind, async (span) => {
    let resealed = 0;
    const rows = await db.select({ id: toolsTable.id, url: toolsTable.url, headersSealed: toolsTable.headersSealed }).from(toolsTable).where(isNotNull(toolsTable.url));
    for (const row of rows) {
      const url = row.url!;
      const headersSealed = { ...row.headersSealed };
      let changed = 0;
      for (const [name, sealed] of Object.entries(row.headersSealed)) {
        if (opens(secrets, sealed, headerAad(row.id, name, url))) continue;
        const legacy = secretAad("tools", row.id, `header:${name}`);
        if (!opens(secrets, sealed, legacy)) continue;
        headersSealed[name] = secrets.seal(secrets.open(sealed, legacy), headerAad(row.id, name, url));
        changed++;
      }
      if (!changed) continue;
      try {
        // Only while the tool still calls the URL read above (the origin it is sealed for) with the headers read: another instance's change wins.
        const updated = await db
          .update(toolsTable)
          .set({ headersSealed })
          .where(and(eq(toolsTable.id, row.id), eq(toolsTable.url, url), sql`${toolsTable.headersSealed} = ${JSON.stringify(row.headersSealed)}::jsonb`))
          .returning({ id: toolsTable.id });
        if (updated.length) resealed += changed;
      } catch (err) {
        logError("tools.reseal failed", err, { ref: row.id });
      }
    }
    span.setAttribute("dispand.tools.resealed", resealed);
    if (resealed > 0) counts.counter("dispand.tools.resealed").add(resealed);
    return { resealed };
  });
}

function opens(secrets: SecretBox, sealed: string, aad: string): boolean {
  try {
    secrets.open(sealed, aad);
    return true;
  } catch {
    return false;
  }
}
