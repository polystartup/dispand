import { execFile } from "node:child_process";
import { detectImage, type ImageType } from "../data/files.ts";
import type { CloudHarnessConfig } from "../harnesses/cloud.ts";
import { oneLine } from "../text.ts";
import { createAnthropicClient } from "./anthropic.ts";
import { createChatClient } from "./openai-chat.ts";
import { createResponsesClient } from "./openai-responses.ts";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: unknown };

// `raw` is the provider-native assistant output, replayed unchanged: the history is append-only.
/**
 * A file attached to a user message: its attachment and name, with its bytes read for each model
 * call (never stored in the transcript). `omitted`: left out of this call by `budgetFiles`.
 */
export type ChatFile = { id: string; name: string; bytes?: Uint8Array; omitted?: true; pages?: number };

export type ChatItem =
  | { role: "user"; text: string; files?: ChatFile[] }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw: unknown }
  | { role: "tool"; callId: string; name: string; result: string; isError: boolean };

export type ModelTurn = {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  /** The tokens the provider counted for this call (cached input included); absent when it sent none. */
  usage?: { input: number; output: number };
};

export type TurnInput = {
  system: string;
  items: ChatItem[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText(delta: string): void;
};

export interface ModelClient {
  turn(input: TurnInput): Promise<ModelTurn>;
}

export type ClientHarness = CloudHarnessConfig & { apiKey?: string };
export type ClientDeps = { fetch?: typeof fetch };

export function createModelClient(h: ClientHarness, deps: ClientDeps = {}): ModelClient {
  switch (h.kind) {
    case "anthropic":
      return createAnthropicClient(h, deps);
    case "openai":
      return createResponsesClient(h, deps);
    case "openai-compatible":
      return createChatClient(h, deps);
  }
}

// Whether providers accept this schema with `strict: true`: every object lists all its properties
// as required and allows no others, and no string has a format (OpenAI's strict-mode rules, which
// Anthropic's also accept).
// Other schemas are sent without `strict`, rather than having the whole request refused.
export function strictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(strictCompatible);
  if (typeof schema !== "object" || schema === null) return true;
  const node = schema as Record<string, unknown>;
  // A string format a provider doesn't know (`uri`) gets the whole request refused in strict mode.
  if (typeof node.format === "string") return false;
  if (node.type === "object" || "properties" in node) {
    const keys = Object.keys((node.properties as Record<string, unknown> | undefined) ?? {});
    const required = Array.isArray(node.required) ? node.required : [];
    if (node.additionalProperties !== false || !keys.every((k) => required.includes(k))) return false;
  }
  return Object.values(node).every(strictCompatible);
}

// Tool arguments the model sent as text that isn't JSON: the loop answers them with an error.
export function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text === "" ? "{}" : text);
  } catch {
    return { __invalid: text };
  }
}

/**
 * What one model call may carry of a chat's files, whatever the provider, so an attachment within
 * Dispand's own limits never gets the call refused (which would end the session, and every later
 * one, since the history is sent again each time):
 * - an image of at most 3.75 MB, which is 5 MB in base64, the strictest provider's limit (Anthropic);
 * - a PDF of at most 100 pages (Anthropic's limit), counted by pdf.js; one it can't read is a line;
 * - text up to 100,000 characters per file, the rest cut with a line saying so;
 * - per call, 16 MiB of files (about 21 MB in base64, under the 32 MB request limit) and 300,000
 *   characters of text, where a PDF page counts as 3,000 (so about 100k tokens at most), the
 *   newest messages' files first: older ones become a line. Tokens aren't counted: this keeps a
 *   chat's files well within a context window, not exactly to it.
 */
export const MAX_IMAGE_INPUT_BYTES = 3_750_000;
export const MAX_PDF_PAGES = 100;
export const MAX_TEXT_INPUT_CHARS = 100_000;
export const MAX_FILE_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_CHARS_PER_CALL = 300_000;
const PDF_PAGE_CHARS = 3_000;

/** How long, and with how much memory, pdf.js may read one PDF's pages. */
const PDF_READ_MS = 5_000;
const PDF_READ_HEAP_MB = 96;

/** The child that reads a PDF's pages: its bytes on stdin, the count on stdout. */
const PDF_PAGES_SCRIPT = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c)).on("end", async () => {
  const { getDocument } = await import(process.argv[1]);
  const doc = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)), verbosity: 0 }).promise;
  process.stdout.write(String(doc.numPages));
  process.exit(0);
});`;

/**
 * A PDF's pages as pdf.js reads them (its current revision, compressed page trees included); null
 * for one it can't read. The PDF may come from anyone, so pdf.js reads it in a child process with
 * no environment, a 96 MB heap and 5 seconds: a crafted file can neither block the server nor
 * exhaust its memory, and one past those limits counts as unreadable.
 */
export async function pdfPages(bytes: Uint8Array): Promise<number | null> {
  const pdfjs = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [`--max-old-space-size=${PDF_READ_HEAP_MB}`, "--input-type=module", "-e", PDF_PAGES_SCRIPT, pdfjs], { env: {}, timeout: PDF_READ_MS, killSignal: "SIGKILL", maxBuffer: 64 }, (err, stdout) => {
      const pages = Number(stdout);
      resolve(!err && Number.isSafeInteger(pages) && pages >= 0 ? pages : null);
    });
    child.stdin?.on("error", () => undefined).end(bytes);
  });
}

type Measured = { kind: "image"; mime: ImageType } | { kind: "pdf" } | { kind: "text"; text: string } | { kind: "other" };

/** What a file is, by its first bytes (never its name). */
function measure(bytes: Uint8Array): Measured {
  const image = detectImage(bytes);
  if (image) return { kind: "image", mime: image };
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-") return { kind: "pdf" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return { kind: "text", text };
  } catch {
    // Not UTF-8: a binary file.
  }
  return { kind: "other" };
}

/** PDFs' pages by attachment id, as `pdfPages` read them. */
const pagesRead = new Map<string, number | null>();

/**
 * The items with the files past a call's budgets (`MAX_FILE_INPUT_BYTES`, `MAX_TEXT_CHARS_PER_CALL`,
 * counted from the newest) marked `omitted`, their bytes dropped, and each PDF's `pages` read.
 * `pdf`: whether the provider takes PDFs; when it doesn't, they cost nothing, since they go as a line.
 */
export async function budgetFiles(items: ChatItem[], options: { pdf: boolean } = { pdf: true }): Promise<ChatItem[]> {
  let bytesLeft = MAX_FILE_INPUT_BYTES;
  let charsLeft = MAX_TEXT_CHARS_PER_CALL;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i]!;
    if (item.role !== "user" || !item.files?.length) continue;
    const files = [...item.files];
    for (let j = files.length - 1; j >= 0; j--) {
      const f = files[j]!;
      if (!f.bytes) continue;
      const m = measure(f.bytes);
      let chars = 0;
      let sent = f.bytes.length;
      if (m.kind === "text") chars = Math.min(m.text.length, MAX_TEXT_INPUT_CHARS);
      else if (m.kind === "pdf" && options.pdf) {
        // A file's bytes never change: read once per attachment, not at every call.
        if (!pagesRead.has(f.id)) {
          if (pagesRead.size >= 10_000) pagesRead.clear();
          pagesRead.set(f.id, await pdfPages(f.bytes));
        }
        const pages = pagesRead.get(f.id) ?? MAX_PDF_PAGES + 1;
        files[j] = { ...f, pages };
        if (pages <= MAX_PDF_PAGES) chars = pages * PDF_PAGE_CHARS;
        else sent = 0;
      } else if (m.kind !== "image" || f.bytes.length > MAX_IMAGE_INPUT_BYTES) sent = 0;
      if (sent <= bytesLeft && chars <= charsLeft) {
        bytesLeft -= sent;
        charsLeft -= chars;
      } else files[j] = { id: f.id, name: f.name, omitted: true };
    }
    out[i] = { ...item, files };
  }
  return out;
}

/**
 * What a model is given for an attached file (`measure`): a raster image as image input, a PDF as
 * document input (where the provider takes one: `pdf`), UTF-8 text as text; anything else, a file
 * past the bounds above, and a file gone, as a line saying so.
 */
export type FileInput =
  | { kind: "image"; mime: ImageType; base64: string }
  | { kind: "pdf"; base64: string }
  | { kind: "text"; text: string }
  | { kind: "note"; text: string };

export function fileInput(file: ChatFile, options: { pdf: boolean } = { pdf: true }): FileInput {
  const named = `“${oneLine(file.name)}”`;
  if (file.omitted) return { kind: "note", text: `The attached file ${named} isn't sent again: with the files of later messages, it would pass what one model call takes.` };
  if (!file.bytes) return { kind: "note", text: `The attached file ${named} is no longer available.` };
  const cannot = { kind: "note" as const, text: `The attached file ${named} (${file.bytes.length} bytes) is in a format or a size this model can't read: only images up to 3.75 MB, PDFs of at most 100 pages (where the model takes them) and text are.` };
  const m = measure(file.bytes);
  if (m.kind === "image") return file.bytes.length > MAX_IMAGE_INPUT_BYTES ? cannot : { kind: "image", mime: m.mime, base64: Buffer.from(file.bytes).toString("base64") };
  // Its pages as `budgetFiles` read them: none read, it isn't sent.
  if (m.kind === "pdf") return options.pdf && file.pages !== undefined && file.pages <= MAX_PDF_PAGES ? { kind: "pdf", base64: Buffer.from(file.bytes).toString("base64") } : cannot;
  if (m.kind === "text") {
    if (m.text.length <= MAX_TEXT_INPUT_CHARS) return { kind: "text", text: `The attached file ${named}:\n${m.text}` };
    // Never between the two halves of a surrogate pair.
    const end = /[\ud800-\udbff]/.test(m.text[MAX_TEXT_INPUT_CHARS - 1]!) ? MAX_TEXT_INPUT_CHARS - 1 : MAX_TEXT_INPUT_CHARS;
    return { kind: "text", text: `The attached file ${named}:\n${m.text.slice(0, end)}\n\n[Cut here: the file goes on for ${m.text.length - end} more characters, past what one model call takes.]` };
  }
  return cannot;
}
