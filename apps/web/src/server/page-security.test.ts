import { expect, test } from "vitest";
import { PAGE_CSP, withPageSecurity } from "./page-security.ts";

const page = (headers: Record<string, string> = {}) => new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("a page keeps what it loads and where it sends to its own origin", () => {
  const res = withPageSecurity(page());
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toBe(PAGE_CSP);
  // Images, media, fonts and connections: the app's own origin (and inline data for images), so a
  // renderer's mistake with an agent's text can't carry data to another host.
  for (const rule of ["img-src 'self' data: blob:", "media-src 'self'", "font-src 'self'", "connect-src 'self'", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    expect(csp.split("; ")).toContain(rule);
  }
  // Nothing in it names another host.
  expect(csp).not.toMatch(/https?:|\*/);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
});

test("only pages get it: a response that set its own policy, or that isn't a page, is left as it is", async () => {
  const file = page({ "content-security-policy": "default-src 'none'; sandbox" });
  expect(withPageSecurity(file).headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  const json = new Response("{}", { headers: { "content-type": "application/json" } });
  expect(withPageSecurity(json).headers.get("content-security-policy")).toBeNull();
  // The body and status go through untouched.
  const res = withPageSecurity(new Response("<p>hi</p>", { status: 404, headers: { "content-type": "text/html" } }));
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("<p>hi</p>");
});
