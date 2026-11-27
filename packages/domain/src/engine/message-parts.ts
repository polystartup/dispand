import { eq, getTableColumns, sql } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { messages } from "../db/schema.ts";

// An assistant message streams as parts (`message_parts`), so each text event writes only its delta;
// the event that ends the message folds them into `messages.text`. A finished message is one row,
// as before. A message still streaming is its `text` and then its parts.

/**
 * How long a message's text grows, in UTF-16 code units: once it reaches this, its later deltas are
 * dropped. It passes it by one delta at most (a runner's event is at most 1 MiB), so the whole text
 * always fits one text value (PostgreSQL holds 1 GB), which the fold and `messageText` build. No
 * model writes an answer that long.
 */
export const MAX_MESSAGE_TEXT = 16 * 1024 * 1024;

/** A message's whole text: `messages.text`, then the parts still streaming into it, in order. */
// Its own names, qualified: a select of one table names its columns bare, which a subquery would read as its own.
export const messageText = sql<string>`("messages"."text" || coalesce((select string_agg(p."text", '' order by p."id") from "message_parts" p where p."message_id" = "messages"."id"), ''))`;

/** A `messages` row with its whole text: `select(messageRow).from(messages)`. */
export const messageRow = { ...getTableColumns(messages), text: messageText };

const { id, runId, stepRunId, role, createdAt, files, result } = getTableColumns(messages);
/**
 * What a text event reads of its step's last message: what `messageView` shows but the text, and
 * the id of its latest part (as text; null when it has none), which tells whether the engine's own
 * copy of the text is current.
 */
export const lastMessage = {
  id,
  runId,
  stepRunId,
  role,
  createdAt,
  files,
  result,
  latestPart: sql<string | null>`(select max(p."id")::text from "message_parts" p where p."message_id" = "messages"."id")`,
};

/** The message's whole text, as `messageText` reads it. */
export async function wholeText(tx: Tx, messageId: string): Promise<string> {
  const [row] = await tx.select({ text: messageText }).from(messages).where(eq(messages.id, messageId));
  return row?.text ?? "";
}

/**
 * Folds the parts of the step's messages into their `text`, and deletes them: those messages ended.
 * Callers hold the step's row (`applyEvent` and `endStep` write it first), as every append does, so
 * no part of the step is added meanwhile, and a second fold finds nothing. Returns the messages folded.
 */
export async function foldParts(tx: Tx, stepRunId: string): Promise<string[]> {
  const result = await tx.execute(sql`
    with gone as (
      delete from "message_parts" p using "messages" m
      where p."message_id" = m."id" and m."step_run_id" = ${stepRunId}
      returning p."message_id", p."id", p."text"
    ), folded as (
      select "message_id", string_agg("text", '' order by "id") as "text" from gone group by "message_id"
    )
    update "messages" m set "text" = m."text" || folded."text" from folded where m."id" = folded."message_id"
    returning m."id"`);
  return (result as { rows: { id: string }[] }).rows.map((r) => r.id);
}
