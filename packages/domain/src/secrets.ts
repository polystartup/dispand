import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { rememberSecret } from "./telemetry/index.ts";

/**
 * Seals secrets (API keys, tool headers and URLs, OAuth state, push keys, Job tokens) before they
 * are stored, with AES-256-GCM and the key from `DISPAND_SECRET_KEY`. The AAD binds a sealed value
 * to its row and field (`secretAad`), so a value copied into another row or column doesn't open; a
 * tool's header is bound to the tool's origin too, so it doesn't open once the tool points
 * elsewhere. A previous key (`DISPAND_SECRET_KEY_PREVIOUS`) still opens what it sealed, while
 * start-up seals that again under the current key (`secrets-reseal.ts`): that is how the key is rotated.
 */
export type SecretBox = {
  /** `v2.<key id>.<iv>.<ciphertext+tag>`, base64url, under the current key, with a random 12-byte IV. */
  seal(plain: string, aad: string): string;
  /**
   * Opens a `v2` value under the key its id names, and a `v1` one (the format before key ids)
   * under whichever key opens it. Throws `SecretError` for another key, another AAD or altered text.
   */
  open(sealed: string, aad: string): string;
  /** The same secret sealed under the current key, its plaintext never out of the box. Throws as `open` does. */
  reseal(sealed: string, aad: string): string;
  /** What every value sealed under the current key starts with. */
  readonly current: string;
  /** Whether the ring holds a previous key: start-up then seals again what isn't under the current one. */
  readonly rotating: boolean;
};

/** Never carries the plaintext or the sealed text. */
export class SecretError extends Error {
  constructor() {
    super("A stored secret couldn't be opened");
    this.name = "SecretError";
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Names a key in what it seals without telling anything of it: hex, so it holds no LIKE wildcard. */
const keyId = (key: Buffer) => createHmac("sha256", key).update("dispand secret key id").digest("hex").slice(0, 8);

function decrypt(key: Buffer, iv: Buffer, body: Buffer, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}

/** A box sealing under `key`, which also opens what `previous` sealed. */
export function createSecretBox(key: Buffer, previous?: Buffer): SecretBox {
  const keys = previous ? [key, previous] : [key];
  if (keys.some((k) => k.length !== 32)) throw new Error("The secret key must be 32 bytes");
  // The current key first: a `v1` value tries it first.
  const ring = new Map(keys.map((k) => [keyId(k), Buffer.from(k)]));
  if (ring.size !== keys.length) throw new Error("The previous secret key must differ from the current one");
  const id = keyId(key);
  const box = ring.get(id)!;
  const current = `v2.${id}.`;
  const seal = (plain: string, aad: string) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", box, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${current}${iv.toString("base64url")}.${body.toString("base64url")}`;
  };
  const unseal = (sealed: string, aad: string): string => {
    const parts = sealed.split(".");
    const tried = parts[0] === "v2" && parts.length === 4 ? [ring.get(parts[1]!)] : parts[0] === "v1" && parts.length === 3 ? [...ring.values()] : [];
    const iv = Buffer.from(parts.at(-2) ?? "", "base64url");
    const body = Buffer.from(parts.at(-1) ?? "", "base64url");
    if (iv.length === IV_BYTES && body.length >= TAG_BYTES) {
      for (const k of tried) {
        try {
          if (k) return decrypt(k, iv, body, aad);
        } catch {
          // Another key, another AAD or altered text: the next key, if any.
        }
      }
    }
    // Node's own errors say nothing secret, but one message keeps every failure alike.
    throw new SecretError();
  };
  return {
    seal,
    open(sealed, aad) {
      const plain = unseal(sealed, aad);
      // Telemetry drops any value equal to it, wherever an instrumentation might pick it up.
      rememberSecret(plain);
      return plain;
    },
    reseal: (sealed, aad) => seal(unseal(sealed, aad), aad),
    current,
    rotating: ring.size > 1,
  };
}

/** The AAD of a secret stored in `table`.`field` of row `rowId`, and only sent to `origin` when given. */
export function secretAad(table: string, rowId: string, field: string, origin?: string): string {
  // Without an origin, the same text as before origins existed: those secrets still open.
  return JSON.stringify(origin === undefined ? [table, rowId, field] : [table, rowId, field, origin]);
}
