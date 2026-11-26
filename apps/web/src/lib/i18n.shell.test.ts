import { ORPCError } from "@orpc/client";
import enMessages from "@dispand/domain/messages/en.json";
import frMessages from "@dispand/domain/messages/fr.json";
import { expect, test } from "vitest";
import { translated } from "./api.ts";

const refusal = (key: string) => new ORPCError("FORBIDDEN", { message: "The server's sentence.", data: { key } });

test("a refusal carrying a shell's key reads in the shell's text, in the page's language", () => {
  expect((translated(refusal("fixture.refused"), "fr") as Error).message).toBe("Refusé par la fixture.");
  expect((translated(refusal("fixture.refused"), "en") as Error).message).toBe("Refused by the fixture.");
});

test("a shell's entry for a public key leaves the public text", () => {
  expect((translated(refusal("workspace.managerOnly"), "en") as Error).message).toBe(enMessages.workspace.managerOnly);
  expect((translated(refusal("workspace.managerOnly"), "fr") as Error).message).toBe(frMessages.workspace.managerOnly);
});
