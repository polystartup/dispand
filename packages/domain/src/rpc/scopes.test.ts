import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { orgOwner } from "./context.ts";
import { router } from "./router.ts";

const src = join(import.meta.dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []);

/** Every procedure of the router, by its path, with the middlewares it runs. */
function procedures(at: Record<string, unknown>, path: string[] = []): { path: string; middlewares: unknown[] }[] {
  return Object.entries(at).flatMap(([key, value]) => {
    const def = (value as { "~orpc"?: { middlewares: unknown[] } })["~orpc"];
    if (def) return [{ path: [...path, key].join("."), middlewares: def.middlewares }];
    return value && typeof value === "object" ? procedures(value as Record<string, unknown>, [...path, key]) : [];
  });
}

/**
 * Every `inScope` call whose scope names an organization and no workspace (spreads aside, which
 * carry a workspace), as `file:enclosing declaration`.
 */
function organizationScopes(): string[] {
  const found: string[] = [];
  for (const path of sources(src)) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const scope = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "inScope" ? node.arguments[0] : undefined;
      if (scope && ts.isObjectLiteralExpression(scope)) {
        const names = scope.properties.map((p) => (ts.isSpreadAssignment(p) ? "..." : p.name && ts.isIdentifier(p.name) ? p.name.text : "?"));
        if (names.includes("organizationId") && !names.includes("workspaceId") && !names.includes("...")) {
          let at: ts.Node | undefined = node.parent;
          while (at && !ts.isVariableDeclaration(at) && !ts.isFunctionDeclaration(at)) at = at.parent;
          const name = at && (ts.isVariableDeclaration(at) || ts.isFunctionDeclaration(at)) && at.name && ts.isIdentifier(at.name) ? at.name.text : "?";
          found.push(`${relative(src, path)}:${name}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

test("only orgOwner procedures open an organization scope", () => {
  // The organization scope (no workspace) is opened in one place: `orgOwner`, after `authorizeOrganization`.
  expect(organizationScopes()).toEqual(["rpc/context.ts:orgOwner"]);
  const all = procedures(router);
  expect(all.length).toBeGreaterThan(100);
  // Every organization procedure goes through `orgOwner`.
  const organization = all.filter((p) => p.path.startsWith("organization."));
  expect(organization.map((p) => p.path)).toEqual(["organization.directory", "organization.assign", "organization.unassign", "organization.removeMember", "organization.transferOwnership"]);
  expect(organization.filter((p) => !p.middlewares.includes(orgOwner))).toEqual([]);
});
