import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { call } from "@orpc/server";
import ts from "typescript";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { createAuth } from "../auth.ts";
import { user, workspaceMembers } from "../db/schema.ts";
import { router } from "../rpc/router.ts";
import { emptyContext, ownerContext, recordingDb } from "../runners/test-support.ts";

const src = join(import.meta.dirname, "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []);

const IDENTITY = new Set(["user", "account", "session", "verification"]);
const root = (node: ts.Expression): ts.Expression => {
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) node = node.expression;
  return node;
};

/** Every write to Better Auth's tables, and whether it goes through `withIdentity`'s identity transaction. */
function identityWrites() {
  const found: { at: string; throughAuthDb: boolean }[] = [];
  for (const path of sources(src)) {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["insert", "update", "delete"].includes(node.expression.name.text)
        && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0]!) && IDENTITY.has(node.arguments[0].text)) {
        // The receiver must be the parameter of the function given to `withIdentity` as its identity work.
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) fn = fn.parent;
        const call = fn?.parent;
        const param = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.parameters[0]?.name : undefined;
        const receiver = root(node.expression.expression);
        const throughAuthDb = !!call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "withIdentity"
          && call.arguments[1] === fn && !!param && ts.isIdentifier(param) && ts.isIdentifier(receiver) && receiver.text === param.text;
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        found.push({ at: `${relative(src, path)}:${line + 1}`, throughAuthDb });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

test("every write to user, account, session and verification goes through authDb", () => {
  const writes = identityWrites();
  // auth.setup and registerInvitation each create a user and its account.
  expect(writes.length).toBeGreaterThanOrEqual(4);
  expect(writes.filter((w) => !w.throughAuthDb).map((w) => w.at)).toEqual([]);
});

test("registerInvitation with a separate authDb creates the user there and the membership in db", { tags: ["pglite-only"] }, async () => {
  const owner = await ownerContext();
  const scope = { organizationId: owner.organizationId, workspaceId: owner.workspaceId };
  const email = "new@example.test";
  const { token } = await call(router.workspace.invite, { ...scope, email, role: "member" }, { context: owner });
  const domain = await recordingDb(owner.db);
  const identity = await recordingDb(owner.db);
  const auth = createAuth(identity.db, { baseURL: "https://dispand.test", secret: "test-secret-test-secret-test-secret", rateLimit: false });
  const anonymous = { ...owner, db: domain.db, authDb: identity.db, auth, headers: new Headers() };
  await expect(call(router.workspace.registerInvitation, { token, name: "New", email, password: "the new user's password" }, { context: anonymous })).resolves.toEqual(scope);
  const writes = (statements: string[]) => statements.filter((s) => /^(insert into|update|delete from) "(user|account|session|verification)"/.test(s));
  expect(writes(identity.statements)).toHaveLength(2);
  expect(writes(domain.statements)).toEqual([]);
  expect(domain.statements.some((s) => s.startsWith('insert into "workspace_members"'))).toBe(true);
  const login = await auth.api.signInEmail({ body: { email, password: "the new user's password" } });
  expect(await owner.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, login.user.id))).toHaveLength(1);
});

/** The owner's install served through a second handle for Better Auth's tables, as a database adapter may. */
async function separate() {
  const owner = await ownerContext();
  const scope = { organizationId: owner.organizationId, workspaceId: owner.workspaceId };
  const identity = await recordingDb(owner.db);
  const auth = createAuth(identity.db, { baseURL: "https://dispand.test", secret: "test-secret-test-secret-test-secret", rateLimit: false });
  return { owner, scope, identity, anonymous: { ...owner, authDb: identity.db, auth, headers: new Headers() } };
}

test("registerInvitation with a separate authDb creates no identity when the inviter may not onboard one", { tags: ["pglite-only"] }, async () => {
  const { owner, scope, identity, anonymous } = await separate();
  const email = "late@example.test";
  const { token } = await call(router.workspace.invite, { ...scope, email, role: "member" }, { context: owner });
  // A server whose people come from another flow enrolls nobody through an invitation.
  await expect(call(router.workspace.registerInvitation, { token, name: "Late", email, password: "the new user's password" }, { context: { ...anonymous, setup: false } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(identity.statements.filter((s) => s.startsWith("insert"))).toEqual([]);
  expect(await owner.db.select().from(user).where(eq(user.email, email))).toEqual([]);
});

test("auth.setup refuses when Better Auth's tables have their own handle", { tags: ["pglite-only"] }, async () => {
  const context = await emptyContext();
  const identity = await recordingDb(context.db);
  const input = { name: "Ada", email: "ada@example.com", password: "correct horse battery", setupCode: context.setupCode };
  await expect(call(router.auth.setup, input, { context: { ...context, authDb: identity.db } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(identity.statements).toEqual([]);
  expect(await context.db.select().from(user)).toEqual([]);
});
