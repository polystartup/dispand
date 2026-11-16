import { expect, test } from "vitest";
import { collect, fakeFetch } from "./fake-fetch.ts";
import { budgetFiles, createModelClient, fileInput, MAX_FILE_INPUT_BYTES, MAX_IMAGE_INPUT_BYTES, MAX_TEXT_INPUT_CHARS, pdfPages, type ChatItem, type ClientHarness } from "./model-client.ts";

// The smallest valid PNG header: signature, then the IHDR chunk's start.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n");
const b64 = (b: Buffer) => b.toString("base64");

const user: ChatItem = {
  role: "user",
  text: "Look",
  files: [
    { id: "att_1", name: "photo.jpg", bytes: PNG },
    { id: "att_2", name: "scan.pdf", bytes: PDF },
    { id: "att_3", name: "notes.txt", bytes: Buffer.from("hello") },
    { id: "att_4", name: "gone.png" },
  ],
};

test("a file is read by its first bytes: image, PDF, text, or a line saying so", () => {
  expect(fileInput({ id: "a", name: "x.txt", bytes: PNG })).toEqual({ kind: "image", mime: "image/png", base64: b64(PNG) });
  expect(fileInput({ id: "a", name: "x.png", bytes: PDF }).kind).toBe("pdf");
  expect(fileInput({ id: "a", name: "x", bytes: Buffer.from("hi") })).toEqual({ kind: "text", text: "The attached file “x”:\nhi" });
  expect(fileInput({ id: "a", name: "x.bin", bytes: Buffer.from([0xff, 0xfe, 0x00]) }).kind).toBe("note");
  expect(fileInput({ id: "a", name: "x" })).toEqual({ kind: "note", text: "The attached file “x” is no longer available." });
});

const cases: [ClientHarness, string, (body: Record<string, unknown>) => unknown][] = [
  [{ kind: "anthropic", model: "m", systemPrompt: "", apiKey: "k", effort: "high" }, "anthropic-end.sse", (b) => (b.messages as { content: unknown }[])[0]!.content],
  [{ kind: "openai", model: "m", systemPrompt: "", apiKey: "k", effort: "low", maxTokens: 100 }, "responses-end.sse", (b) => (b.input as { content: unknown }[])[0]!.content],
  [{ kind: "openai-compatible", model: "m", systemPrompt: "", apiKey: "k", baseUrl: "https://llm.test/v1" } as ClientHarness, "chat-end.sse", (b) => (b.messages as { role: string; content: unknown }[]).find((m) => m.role === "user")!.content],
];

test.each(cases)("%o gets an image as image input, and a PDF as document input where the provider takes one", async (harness, fixture, content) => {
  const { fetch, sent } = fakeFetch(fixture);
  await createModelClient(harness, { fetch }).turn({ system: "", items: [user], tools: [], ...collect() });
  const parts = content(sent[0]!.body) as Record<string, unknown>[];
  expect(parts).toHaveLength(5);
  const expected = {
    anthropic: [
      { type: "text", text: "Look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64(PNG) } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(PDF) }, title: "scan.pdf" },
      { type: "text", text: "The attached file “notes.txt”:\nhello" },
      { type: "text", text: "The attached file “gone.png” is no longer available." },
    ],
    openai: [
      { type: "input_text", text: "Look" },
      { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${b64(PNG)}` },
      { type: "input_file", filename: "scan.pdf", file_data: `data:application/pdf;base64,${b64(PDF)}` },
      { type: "input_text", text: "The attached file “notes.txt”:\nhello" },
      { type: "input_text", text: "The attached file “gone.png” is no longer available." },
    ],
    "openai-compatible": [
      { type: "text", text: "Look" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64(PNG)}` } },
      { type: "text", text: `The attached file “scan.pdf” (${PDF.length} bytes) is in a format or a size this model can't read: only images up to 3.75 MB, PDFs of at most 100 pages (where the model takes them) and text are.` },
      { type: "text", text: "The attached file “notes.txt”:\nhello" },
      { type: "text", text: "The attached file “gone.png” is no longer available." },
    ],
  }[harness.kind];
  expect(parts).toEqual(expected);
});

test("an image past what a provider takes becomes a line, not image input", () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_INPUT_BYTES)]);
  expect(fileInput({ id: "a", name: "huge.png", bytes: big })).toEqual({
    kind: "note",
    text: `The attached file “huge.png” (${big.length} bytes) is in a format or a size this model can't read: only images up to 3.75 MB, PDFs of at most 100 pages (where the model takes them) and text are.`,
  });
  expect(fileInput({ id: "a", name: "ok.png", bytes: Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_INPUT_BYTES - PNG.length)]) }).kind).toBe("image");
});

test("a long text is cut, with a line saying how much was left out", () => {
  const input = fileInput({ id: "a", name: "log.txt", bytes: Buffer.from("x".repeat(MAX_TEXT_INPUT_CHARS + 5)) });
  expect(input).toEqual({ kind: "text", text: `The attached file “log.txt”:\n${"x".repeat(MAX_TEXT_INPUT_CHARS)}\n\n[Cut here: the file goes on for 5 more characters, past what one model call takes.]` });
});

test("one call carries at most 16 MiB of files: the newest messages' first, older ones become a line", () => {
  const mib = (n: number) => Buffer.alloc(n * 1024 * 1024, 0x61);
  const items: ChatItem[] = [
    { role: "user", text: "old", files: [{ id: "a1", name: "old.txt", bytes: mib(8) }] },
    { role: "assistant", text: "ok", toolCalls: [], raw: null },
    { role: "user", text: "new", files: [{ id: "a2", name: "one.txt", bytes: mib(6) }, { id: "a3", name: "two.txt", bytes: mib(6) }] },
  ];
  const sent = budgetFiles(items);
  const files = sent.flatMap((i) => (i.role === "user" ? i.files! : []));
  expect(files.map((f) => [f.id, !!f.bytes, f.omitted ?? false])).toEqual([["a1", false, true], ["a2", true, false], ["a3", true, false]]);
  expect(files.reduce((n, f) => n + (f.bytes?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_FILE_INPUT_BYTES);
  expect(fileInput(files[0]!)).toEqual({ kind: "note", text: "The attached file “old.txt” isn't sent again: with the files of later messages, it would pass what one model call takes." });
  // The stored items are untouched.
  expect(items[0]!.role === "user" && items[0]!.files![0]!.bytes).toBeTruthy();
});

test("one call carries at most 300,000 characters of text: ten long texts send the newest three, the others become a line", () => {
  const items: ChatItem[] = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, text: `file ${i}`, files: [{ id: `a${i}`, name: `${i}.txt`, bytes: Buffer.from("y".repeat(MAX_TEXT_INPUT_CHARS)) }] }));
  const files = budgetFiles(items).flatMap((i) => (i.role === "user" ? i.files! : []));
  expect(files.filter((f) => f.bytes).map((f) => f.id)).toEqual(["a7", "a8", "a9"]);
  expect(files.filter((f) => f.omitted)).toHaveLength(7);
});

/** A PDF whose page tree says it has `pages` pages. */
const pdfOf = (pages: number) => Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj\n`);

test("a PDF past 100 pages becomes a line; its pages count in the call's text budget, 100 when they can't be counted", () => {
  expect(pdfPages(pdfOf(12))).toBe(12);
  expect(pdfPages(Buffer.from("%PDF-1.7\n3 0 obj << /Type /Page >> endobj\n4 0 obj << /Type /Page >> endobj\n"))).toBe(2);
  expect(pdfPages(Buffer.from("%PDF-1.7\n5 0 obj << /Type /ObjStm /Filter /FlateDecode >> stream\n...\n"))).toBe(100);
  expect(fileInput({ id: "a", name: "book.pdf", bytes: pdfOf(101) }).kind).toBe("note");
  expect(fileInput({ id: "a", name: "short.pdf", bytes: pdfOf(100) }).kind).toBe("pdf");
  // 100 pages take the whole text budget: an older PDF of 1 page is left out.
  const items: ChatItem[] = [
    { role: "user", text: "old", files: [{ id: "p1", name: "one.pdf", bytes: pdfOf(1) }] },
    { role: "user", text: "new", files: [{ id: "p2", name: "hundred.pdf", bytes: pdfOf(100) }] },
  ];
  const files = budgetFiles(items).flatMap((i) => (i.role === "user" ? i.files! : []));
  expect(files.map((f) => [f.id, f.omitted ?? false])).toEqual([["p1", true], ["p2", false]]);
});

test("a cut never splits a surrogate pair", () => {
  const text = "a".repeat(MAX_TEXT_INPUT_CHARS - 1) + "😀" + "b";
  const input = fileInput({ id: "a", name: "emoji.txt", bytes: Buffer.from(text) });
  const body = input.kind === "text" ? input.text.split("\n")[1]! : "";
  expect(body).toBe("a".repeat(MAX_TEXT_INPUT_CHARS - 1));
  expect(body.isWellFormed()).toBe(true);
  expect(input.kind === "text" && input.text.endsWith("[Cut here: the file goes on for 3 more characters, past what one model call takes.]")).toBe(true);
});
