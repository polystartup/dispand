import { call } from "@orpc/server";
import { router } from "@dispand/domain";
import { ownerContext } from "@dispand/domain/test-support";
import { expect, test } from "vitest";
import { handleFileDownload } from "./files.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

/** An app with its owner signed in, a table, and a way to upload to it. */
async function owner() {
  const context = await ownerContext();
  const cookie = context.headers.get("cookie")!;
  const table = await call(router.tables.create, { name: "Projects" }, { context });
  const upload = (bytes: Uint8Array<ArrayBuffer>, name: string) => call(router.files.upload, { tableId: table.id, file: new File([bytes], name) }, { context });
  const get = (id: string, headers: Record<string, string> = { cookie }) => handleFileDownload(new Request(`http://localhost:3000/files/${id}`, { headers }), context);
  return { db: context.db, upload, get };
}

test("download needs the owner's session", async () => {
  const { db, upload, get } = await owner();
  const file = await upload(PNG, "a.png");
  expect((await get(file.id, {})).status).toBe(401);
  // Another owner's file is not found, like a file that doesn't exist.
  await db.execute(`insert into "user" (id, name, email) values ('user_other', 'Eve', 'eve@example.com')`);
  await db.execute(`insert into tables (id, owner_id, name) values ('tbl_other', 'user_other', 'Secrets')`);
  await db.execute(`insert into attachments (id, owner_id, table_id, name, mime, size, image) values ('att_other', 'user_other', 'tbl_other', 's.png', 'image/png', 1, true)`);
  expect((await get("att_other")).status).toBe(404);
  expect((await get("att_missing")).status).toBe(404);
  expect((await get("..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
});

test("an SVG or HTML named .png is served as a download, never inline", async () => {
  const { upload, get } = await owner();
  for (const bytes of [SVG, HTML]) {
    const res = await get((await upload(bytes, "logo.png")).id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  }
});

test("a PNG is served inline with its sniffed type", async () => {
  const { upload, get } = await owner();
  const res = await get((await upload(PNG, "photo.bin")).id);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
});

test("a name with quotes and non-ASCII is encoded", async () => {
  const { upload, get } = await owner();
  const res = await get((await upload(SVG, '“Logo” "v2"\r\n(final)*.svg')).id);
  const disposition = res.headers.get("content-disposition")!;
  expect(disposition).toBe("attachment; filename*=UTF-8''%E2%80%9CLogo%E2%80%9D%20%22v2%22%0D%0A%28final%29%2A.svg");
  expect(disposition).not.toContain('"');
  await res.body?.cancel();
});
