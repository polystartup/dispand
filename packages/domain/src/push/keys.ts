import { eq } from "drizzle-orm";
import { generateVAPIDKeys } from "web-push";
import type { Db } from "../db/client.ts";
import { pushKeys } from "../db/schema.ts";
import { secretAad, type SecretBox } from "../secrets.ts";

const ID = "vapid";
const aad = secretAad("push_keys", ID, "private_key");

/** The install's VAPID key pair: made the first time it is needed, the private key kept in the secret box. */
export async function vapidKeys(db: Db, secrets: SecretBox): Promise<{ publicKey: string; privateKey: string }> {
  const read = async () => (await db.select().from(pushKeys).where(eq(pushKeys.id, ID)))[0];
  let row = await read();
  if (!row) {
    const made = generateVAPIDKeys();
    // Two first callers at once: one insert wins, both read it.
    await db.insert(pushKeys).values({ id: ID, publicKey: made.publicKey, privateKey: secrets.seal(made.privateKey, aad) }).onConflictDoNothing();
    row = (await read())!;
  }
  return { publicKey: row.publicKey, privateKey: secrets.open(row.privateKey, aad) };
}

/** A subscription's keys are bound to its endpoint, which never changes for its row. */
export const subscriptionKeysAad = (endpoint: string) => secretAad("push_subscriptions", endpoint, "keys");
