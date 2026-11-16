import { sentence } from "../messages/index.ts";
import type { NotImported } from "./fs.ts";

/** What a read left out, with each reason as its English sentence: tests compare words, not keys. */
export const inEnglish = (notes: NotImported[]) => notes.map((n) => ({ ...n, reason: sentence(n.reason) }));
