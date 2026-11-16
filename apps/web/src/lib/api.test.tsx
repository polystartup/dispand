import { message, router } from "@dispand/domain";
import { emptyContext } from "@dispand/domain/test-support";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError, os, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { validateWorkflow } from "@dispand/domain/workflows/derive";
import { cronProblem } from "@dispand/domain/workflows/schedule";
import { handleRpc } from "../server/rpc.ts";
import type { Language } from "./i18n.ts";
import { translated, translateErrors } from "./api.ts";

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
    trigger: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("triggers.inboxNeeded"));
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
    rows: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("data.table.parentRowsMissing", { count: 3, parent: "Clients" }));
    }),
    taken: os.handler(() => {
      throw new ORPCError("CONFLICT", message("data.table.nameTaken", { name: "Clients" }));
    }),
    markup: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", message("plugins.uninstall.choose", { name: "<b>case-law</b>" }));
    }),
    unknown: os.handler(() => {
      throw new ORPCError("BAD_REQUEST", { message: "A key from a newer server", data: { key: "plugins.neverHeardOf" } });
    }),
    database: os.handler(() => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "plugins_name" (secret-row)'), { code: "23505" });
    }),
  },
};
const handler = new RPCHandler(failing);

async function client(language: Language) {
  // A Job's context passes `authed`: what fails here is the input, before any handler runs.
  const app = { ...(await emptyContext()), job: { runId: "run", ownerId: "owner", agentId: "agent" } };
  const link = new RPCLink({
    url: "http://localhost:3000/api/rpc",
    headers: { "x-csrf-token": "orpc" },
    fetch: (request) => handleRpc(request as Request, app, handler as never),
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

test("a tables refusal shows in French, with its plural and the name the person typed", async () => {
  expect(await refusal((await client("fr")).fails.rows())).toBe("3 lignes de cette table n’ont pas de Clients : renseignez-les d’abord.");
  expect(await refusal((await client("fr")).fails.taken())).toBe("Une table s’appelle déjà « Clients ».");
  expect(await refusal((await client("en")).fails.taken())).toBe("A table is already called “Clients”.");
});

test("a trigger refusal, a schedule's and a workflow's issue show in French, their values kept as typed", async () => {
  expect(await refusal((await client("fr")).fails.trigger())).toBe("Seul un agent doté de la Boîte de réception peut être lancé par des Questions : donnez-lui d’abord la Boîte de réception.");
  const config = { kind: "primitive", tableId: "interaction", operations: ["updated"] };
  expect(await refusal((await client("fr")).triggers.create({ agentId: "a", name: "T", config } as never))).toBe("Ces changements ne sont pas de ceux de ce que le déclencheur surveille.");
  expect(await refusal((await client("fr")).fails.schedule())).toBe("Utilisez 5 champs : minute heure jour mois jour de la semaine.");
  expect(await refusal((await client("fr")).fails.issue())).toBe("{{go.x}} : « go » est un bouton, il n’a pas de valeurs");
  expect(await refusal((await client("en")).fails.issue())).toBe("{{go.x}}: “go” is a button, it has no values");
});

test("an input its Zod schema rejects shows a validation message in French", async () => {
  const api = await client("fr");
  expect(await refusal(api.questions.answer({ questionId: 7 } as never))).toBe("« questionId » n’a pas le bon type.");
  expect(await refusal(api.questions.list({ status: "everything" } as never))).toBe("« status » doit valoir l’un de : pending, all.");
});

test("a value with markup renders as text", async () => {
  const shown = renderToString(<p role="alert">{await refusal((await client("en")).fails.markup())}</p>);
  expect(shown).toContain("each element &lt;b&gt;case-law&lt;/b&gt; would");
  expect(shown).not.toContain("<b>");
});

test("a key the page doesn't know shows the generic error, in English when the page is", async () => {
  expect(await refusal((await client("en")).fails.unknown())).toBe("Something went wrong. Try again.");
  expect(await refusal((await client("fr")).fails.unknown())).toBe("Une erreur s’est produite. Réessayez.");
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
