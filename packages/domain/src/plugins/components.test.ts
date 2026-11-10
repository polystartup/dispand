import { expect, test } from "vitest";
import { placeholdersInPathOrQuery } from "./components.ts";

test("URL settings may fill only a path or query, as the URL parser reads it", () => {
  const cases: [string, boolean][] = [
    ["https://mcp.example.com/${TENANT}/mcp", true],
    ["https://mcp.example.com/mcp?key=${KEY}", true],
    ["https://mcp.example.com?key=${KEY}", true],
    ["https://${TENANT}.example.com/mcp", false],
    ["https://mcp.example.com:${PORT}/mcp", false],
    ["https://user:${PASS}@mcp.example.com/mcp", false],
    ["${SCHEME}://mcp.example.com/mcp", false],
    ["https://${HOST}", false],
    // A default holding a slash, and a third slash, still put the setting in the host.
    ["https://${TENANT:-unused/path}.invalid/mcp", false],
    ["https:///${KEY}.invalid/mcp", false],
    ["https://mcp.example.com/mcp#${FRAGMENT}", false],
    ["https://mcp.example.com/a/${A}/b?x=${B}&y=${A}", true],
  ];
  for (const [template, ok] of cases) expect([template, placeholdersInPathOrQuery(template)]).toEqual([template, ok]);
});
