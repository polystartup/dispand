import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { parse, owner, unwrap, where } from "../test-support-source.ts";
import { manager, member, notJob, orgOwner, signedIn } from "./context.ts";
import { router } from "./router.ts";

const src = join(import.meta.dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );

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
  expect(organization.map((p) => p.path)).toEqual([
    "organization.directory",
    "organization.assign",
    "organization.unassign",
    "organization.removeMember",
    "organization.archiveMember",
    "organization.archived",
    "organization.restoreMember",
    "organization.transferOwnership",
    "organization.retention",
    "organization.setRetention",
  ]);
  expect(organization.filter((p) => !p.middlewares.includes(orgOwner))).toEqual([]);
});

test("every procedure admits its caller through a gate, but the few meant to be public", () => {
  const gates: unknown[] = [signedIn, member, manager, orgOwner];
  const open = procedures(router)
    .filter((p) => !p.middlewares.some((m) => gates.includes(m)))
    .map((p) => p.path);
  // First-run setup and its status, and a new account's sign-up through an invitation, checked by its token.
  expect(open).toEqual(["auth.setup", "auth.status", "workspace.registerInvitation", "workspace.registrationPreview"]);
});

/**
 * Every `if` whose condition is a caller's Job alone (`context.job`, `context.jobPlace`) and whose
 * only statement throws: a Job refused as such, as `file#function`. A refusal that depends on the
 * input too (`context.job && input.skillId`) is not one.
 */
function jobRefusals(): string[] {
  const found: string[] = [];
  for (const path of sources(src)) {
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && !node.elseStatement) {
        const condition = unwrap(node.expression);
        const then = ts.isBlock(node.thenStatement) && node.thenStatement.statements.length === 1 ? node.thenStatement.statements[0]! : node.thenStatement;
        if (ts.isPropertyAccessExpression(condition) && ["job", "jobPlace"].includes(condition.name.text) && ts.isThrowStatement(then)) {
          const at = owner(node);
          if (!at) throw new Error(`a Job refusal outside any declaration: ${where(node)}`);
          found.push(`${relative(src, path)}#${at.path}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(path));
  }
  return found;
}

test("a procedure refuses a Job only through notJob, and these are the procedures that do", () => {
  // One refusal for every Job, whichever procedure it calls: no procedure or middleware of its own says it.
  expect(jobRefusals()).toEqual(["rpc/context.ts#notJob"]);
  const refusing = procedures(router)
    .filter((p) => p.middlewares.includes(notJob))
    .map((p) => p.path)
    .sort();
  // A person's own acts: their workspaces, invitations, profile and subscriptions, what they send a chat, and the owner's say over plugins and native CLI rules.
  expect(refusing).toEqual([
    "agents.cliRules",
    "agents.removeCliRule",
    "agents.setNativePlugins",
    "assistantCommands",
    "files.hold",
    "plugins.conflicts",
    "plugins.resolveConflict",
    "plugins.uninstall",
    "plugins.uninstallPreview",
    "profile.get",
    "profile.update",
    "runners.endSubscription",
    "runners.startEnrollment",
    "runs.editQueued",
    "runs.interruptChat",
    "runs.removeQueued",
    "runs.steerQueued",
    "workspace.acceptInvitation",
    "workspace.invitation",
    "workspace.invitations",
    "workspace.invite",
    "workspace.managed",
    "workspace.mine",
    "workspace.people",
    "workspace.registerInvitation",
    "workspace.registrationPreview",
    "workspace.removePerson",
    "workspace.revokeInvitation",
  ]);
});
