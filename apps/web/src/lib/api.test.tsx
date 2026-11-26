import { message, registerMessages, router, type MessageKey } from "@dispand/domain";
import { emptyContext, firedBySchedule, jobIdentity, ownerContext } from "@dispand/domain/test-support";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError, os, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { renderToString } from "react-dom/server";
import { expect, onTestFinished, test } from "vitest";
import { validateWorkflow } from "@dispand/domain/workflows/derive";
import { cronProblem } from "@dispand/domain/workflows/schedule";
import { handleRpc } from "../server/rpc.ts";
import type { Language } from "./i18n.ts";
import { setWorkspace, translated, translateErrors, workspaceHeaders } from "./api.ts";
import { forgetRefusals, organizationRefusalOf, refusalFor } from "./organization-refusal.ts";

// Procedures that fail as the page's own can: through the server's handler and the page's link.
const failing = {
  ...router,
  fails: {
    keyed: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("plugins.uninstall.choose", { name: "case-law" }));
    }),
    listed: os.handler(() => {
      throw new ORPCError("CONFLICT", message("plugins.marketplace.removeFirst", { plugins: ["case-law", "tax", "labour"] }));
    }),
    plain: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", { message: "Plain words nobody keyed" });
    }),
    git: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("git.fetch.timeout", { url: "https://example.com/a.git", seconds: 60 }));
    }),
    trigger: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("triggers.needsPrimitive"));
    }),
    schedule: os.handler(() => {
      const problem = cronProblem("0 0 9 * * *", "Europe/Paris")!;
      throw new ORPCError("BAD_REQUEST", message(problem.key, problem.values));
    }),
    issue: os.handler(() => {
      const [issue] = validateWorkflow({
        trigger: { type: "manual", field: { id: "n_go", key: "go", type: "button", label: "Go" } },
        steps: [{ id: "n_a", key: "a", type: "agent", name: "A", agentId: "agent_1", prompt: "Use {{go.x}}." }],
        edges: [{ from: "n_go", to: "n_a" }],
      });
      throw new ORPCError("BAD_REQUEST", message(issue!.message.key, issue!.message.values));
    }),
    guard: os.handler(() => {
      throw new ORPCError("FORBIDDEN", message("agent.guard.delete"));
    }),
    holder: os.handler(() => {
      throw new ORPCError("CONFLICT", message("tools.holder.stays.agent", { name: "Searcher" }));
    }),
    rows: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("data.table.parentRowsMissing", { count: 3, parent: "Clients" }));
    }),
    taken: os.handler(() => {
      throw new ORPCError("CONFLICT", message("data.table.nameTaken", { name: "Clients" }));
    }),
    setup: os.handler(() => {
      throw new ORPCError("FORBIDDEN", message("auth.setupRefused"));
    }),
    runnerUsed: os.handler(() => {
      throw new ORPCError("CONFLICT", message("runners.usedByHarness"));
    }),
    markup: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("plugins.uninstall.choose", { name: "<b>case-law</b>" }));
    }),
    unknown: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", { message: "A key from a newer server", data: { key: "plugins.neverHeardOf" } });
    }),
    // The refusal `limitRefusal` (domain `rpc/context.ts`) answers for a database limit naming a registered key.
    limited: os.handler(() => {
      throw new ORPCError("FORBIDDEN", message("limits.testOnly" as MessageKey));
    }),
    // The refusal of a whole organization by its install (domain `workspace/gate.ts`), on a call and mid-stream.
    refused: os.handler(() => {
      throw orgRefused("org_r");
    }),
    refusedLater: os.handler(async function* () {
      yield { count: 1 };
      throw orgRefused("org_s");
    }),
    database: os.handler(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "plugins_name" (secret-row)'), { code: "23505" });
    }),
  },
};
registerMessages("en", { "limits.testOnly": "A registered limit" });
function orgRefused(organizationId: string) {
  const { message: text, data } = message("organization.refused");
  return new ORPCError("FORBIDDEN", { message: text, data: { ...data, link: "/help", organizationId } });
}
const handler = new RPCHandler(failing);

async function jobContext() {
  const context = await ownerContext();
  const job = await jobIdentity(context);
  // No person behind it: a Job has a manager's rights only through one.
  await firedBySchedule(context, job.runId);
  return { ...context, job };
}

/** A client of the app; with `app`, as its Job, or as its owner signed in when it has no Job. */
async function client(language: Language, app?: Awaited<ReturnType<typeof ownerContext>> & { job?: Awaited<ReturnType<typeof jobContext>>["job"] }) {
  const context = app ?? await emptyContext();
  const link = new RPCLink({
    url: "http://localhost:3000/api/rpc",
    headers: { "x-csrf-token": "orpc", ...(app && !app.job ? { cookie: app.headers.get("cookie")! } : {}) },
    fetch: (request) => handleRpc(request as Request, context, handler as never),
    interceptors: [translateErrors(() => language)],
  });
  return createORPCClient<RouterClient<typeof failing>>(link);
}

const refusal = (call: Promise<unknown>) => call.then(() => expect.unreachable(), (err: Error) => err.message);

test("a server message shows in the page's language, with its values", async () => {
  expect(await refusal((await client("fr")).fails.keyed())).toBe("Choisissez ce que deviennent les éléments que case-law laisserait, puis désinstallez-le à nouveau.");
  expect(await refusal((await client("en")).fails.keyed())).toBe("Choose what happens to each element case-law would leave behind, then uninstall it again.");
});

test("a plugins refusal shows in French, its list of plugins written as French lists are", async () => {
  expect(await refusal((await client("fr")).fails.listed())).toBe("Retirez d’abord ses plugins : case-law, tax et labour.");
  expect(await refusal((await client("en")).fails.listed())).toBe("Remove its plugins first: case-law, tax, and labour.");
});

test("a Git refusal shows in French, its address and seconds kept", async () => {
  expect(await refusal((await client("fr")).fails.git())).toBe("Impossible de récupérer https://example.com/a.git : cela a pris plus de 60 s.");
});

test("a tables refusal shows in French, with its plural and the name the person typed", async () => {
  expect(await refusal((await client("fr")).fails.rows())).toBe("3 lignes de cette table n’ont pas de Clients : renseignez-les d’abord.");
  expect(await refusal((await client("fr")).fails.taken())).toBe("Une table s’appelle déjà « Clients ».");
  expect(await refusal((await client("en")).fails.taken())).toBe("A table is already called “Clients”.");
});

test("a trigger refusal, a schedule's and a workflow's issue show in French, their values kept as typed", async () => {
  expect(await refusal((await client("fr")).fails.trigger())).toBe("Seules les modifications d’une table primitive lancent des Jobs : rendez d’abord la table primitive.");
  const config = { kind: "primitive", tableId: "job", operations: ["updated"] };
  expect(await refusal((await client("fr", await jobContext())).triggers.create({ agentId: "a", name: "T", config } as never))).toBe("Ces changements ne sont pas de ceux de ce que le déclencheur surveille.");
  expect(await refusal((await client("fr")).fails.schedule())).toBe("Utilisez 5 champs : minute heure jour mois jour de la semaine.");
  expect(await refusal((await client("fr")).fails.issue())).toBe("{{go.x}} : « go » est un bouton, il n’a pas de valeurs");
  expect(await refusal((await client("en")).fails.issue())).toBe("{{go.x}}: “go” is a button, it has no values");
});

test("an agents refusal and a tools refusal show in French, the agent's name as typed", async () => {
  expect(await refusal((await client("fr")).fails.guard())).toBe("L’Assistant ne peut pas être supprimé.");
  expect(await refusal((await client("fr")).fails.holder())).toBe("L’agent « Searcher » utilise cet outil : il reste sur son runner.");
  expect(await refusal((await client("en")).fails.holder())).toBe("The agent “Searcher” uses this tool: it stays on its runner.");
  // A refinement of the tools area, through the server's own validation.
  const add = { name: "A", url: "https://u:p@example.com/mcp", transport: "streamable-http" } as const;
  expect(await refusal((await client("fr", await ownerContext())).tools.add(add))).toBe("L’URL ne peut pas contenir d’identifiants.");
});

test("an auth refusal and a runners refusal show in French", async () => {
  expect(await refusal((await client("fr")).fails.setup())).toBe("La configuration initiale n’est pas autorisée.");
  expect(await refusal((await client("fr")).fails.runnerUsed())).toBe("Un harnais utilise ce runner.");
  // Through the real router: a Job is a member at most, and can't ask a runner to update.
  expect(await refusal((await client("fr", await jobContext())).runners.installUpdate({ runnerId: "r" }))).toBe("Seul un responsable de cet espace de travail peut faire cela.");
  expect(await refusal((await client("en", await jobContext())).runners.installUpdate({ runnerId: "r" }))).toBe("Only a manager of this workspace can do this.");
});

test("an input its Zod schema rejects shows a validation message in French", async () => {
  const api = await client("fr", await jobContext());
  expect(await refusal(api.questions.answer({ questionId: 7 } as never))).toBe("« questionId » n’a pas le bon type.");
  expect(await refusal(api.questions.list({ status: "everything" } as never))).toBe("« status » doit valoir l’un de : pending, all.");
});

test("a value with markup renders as text", async () => {
  const shown = renderToString(<p role="alert">{await refusal((await client("en")).fails.markup())}</p>);
  expect(shown).toContain("each element &lt;b&gt;case-law&lt;/b&gt; would");
  expect(shown).not.toContain("<b>");
});

test("an error without a key shows the generic message, never its words", async () => {
  expect(await refusal((await client("fr")).fails.plain())).toBe("Une erreur s’est produite. Réessayez.");
});

test("a key the page doesn't know shows the server's message, a key it knows still translates", async () => {
  expect(await refusal((await client("en")).fails.unknown())).toBe("A key from a newer server");
  expect(await refusal((await client("fr")).fails.unknown())).toBe("A key from a newer server");
  expect(await refusal((await client("fr")).fails.taken())).toBe("Une table s’appelle déjà « Clients ».");
});

test("a refusal naming a key an embedding entry registered on the server reaches the page's text", async () => {
  expect(await refusal((await client("en")).fails.limited())).toBe("A registered limit");
});

test("a raw database error reaches the page as the translated generic message, never its text", async () => {
  const text = await refusal((await client("fr")).fails.database());
  expect(text).toBe("Une erreur s’est produite. Réessayez.");
  expect(text).not.toMatch(/duplicate|secret-row|plugins_name/);
});

test("a message with a count takes the plural form of the page's language", () => {
  const shown = (count: number) => (translated(new ORPCError("BAD_REQUEST", message("validation.too_small.string", { field: "x", count })), "fr") as Error).message;
  expect([shown(1), shown(3)]).toEqual(["« x » demande au moins 1 caractère.", "« x » demande au moins 3 caractères."]);
});

test("calls name the page's workspace in headers once it is known, and none before", () => {
  expect(workspaceHeaders()).toEqual({});
  setWorkspace({ organizationId: "org_1", workspaceId: "ws_1" });
  expect(workspaceHeaders()).toEqual({ "dispand-organization": "org_1", "dispand-workspace": "ws_1" });
  setWorkspace(null);
  expect(workspaceHeaders()).toEqual({});
});

test("an organization's refusal is noted for the organization it names, in the page's language, with its link", async () => {
  onTestFinished(forgetRefusals);
  // The tab works in another organization: a call sent before a switch can fail after it.
  setWorkspace({ organizationId: "org_other", workspaceId: "ws_other" });
  onTestFinished(() => setWorkspace(null));
  expect(await refusal((await client("fr")).fails.refused())).toBe("Cette organisation ne peut pas être utilisée pour le moment.");
  expect(refusalFor("org_r")).toEqual({ organizationId: "org_r", message: "Cette organisation ne peut pas être utilisée pour le moment.", link: "/help" });
  expect(refusalFor("org_other")).toBeUndefined();
});

test("a refusal a stream sends after it opened is noted too, translated", async () => {
  onTestFinished(forgetRefusals);
  const stream = await (await client("fr")).fails.refusedLater();
  expect(await stream.next()).toEqual({ done: false, value: { count: 1 } });
  expect(await stream.next().then(() => expect.unreachable(), (err: Error) => err.message)).toBe("Cette organisation ne peut pas être utilisée pour le moment.");
  expect(refusalFor("org_s")?.link).toBe("/help");
});

test("other refusals stay the caller's to show: nothing is noted for the page", async () => {
  const api = await client("en");
  for (const call of [api.fails.guard(), api.fails.limited(), api.fails.setup()]) expect(organizationRefusalOf(await call.catch((err: unknown) => err))).toBeUndefined();
});
