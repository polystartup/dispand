import { expect, test } from "vitest";
import { collect, fakeFetch } from "./fake-fetch.ts";
import { createModelClient, fileInput, type ChatItem, type ClientHarness } from "./model-client.ts";

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

test.each(cases)("%o gets an image as image input and a PDF as document input", async (harness, fixture, content) => {
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
      { type: "file", file: { filename: "scan.pdf", file_data: `data:application/pdf;base64,${b64(PDF)}` } },
      { type: "text", text: "The attached file “notes.txt”:\nhello" },
      { type: "text", text: "The attached file “gone.png” is no longer available." },
    ],
  }[harness.kind];
  expect(parts).toEqual(expected);
});
