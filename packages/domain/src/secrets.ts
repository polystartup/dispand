import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { rememberSecret } from "./telemetry/index.ts";

/**
 * Seals secrets (API keys, tool headers) before they are stored, with AES-256-GCM and the key
 * from `DISPAND_SECRET_KEY`. The AAD binds a sealed value to its row and field
 * (`secretAad`), so a value copied into another row or column doesn't open.
 */
export type SecretBox = {
  /** `v1.<iv>.<ciphertext+tag>`, base64url, with a random 12-byte IV. */
  seal(plain: string, aad: string): string;
  /** Throws `SecretError` for another key, another AAD or altered text. */
  open(sealed: string, aad: string): string;
};

/** Never carries the plaintext or the sealed text. */
export class SecretError extends Error {
  constructor() {
    super("A stored secret couldn't be opened");
    this.name = "SecretError";
  }
}

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("The secret key must be 32 bytes");
  const box = Buffer.from(key);
  return {
    seal(plain, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", box, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
    },
    open(sealed, aad) {
      try {
        const [version, ivText, bodyText, ...rest] = sealed.split(".");
        if (version !== VERSION || ivText === undefined || bodyText === undefined || rest.length) throw new SecretError();
        const iv = Buffer.from(ivText, "base64url");
        const body = Buffer.from(bodyText, "base64url");
        if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new SecretError();
        const decipher = createDecipheriv("aes-256-gcm", box, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
        // Telemetry drops any value equal to it, wherever an instrumentation might pick it up.
        rememberSecret(plain);
        return plain;
      } catch {
        // Node's own errors say nothing secret, but one message keeps every failure alike.
        throw new SecretError();
      }
    },
  };
}

/** The AAD of a secret stored in `table`.`field` of row `rowId`. */
export function secretAad(table: string, rowId: string, field: string): string {
  return JSON.stringify([table, rowId, field]);
}
