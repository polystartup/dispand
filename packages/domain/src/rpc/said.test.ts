import { call, ORPCError } from "@orpc/server";
import { expect, test } from "vitest";
import { english, SayError } from "../messages/index.ts";
import { PackageError } from "../skills/package.ts";
import { base } from "./context.ts";

class Taken extends SayError {
  override readonly code = "CONFLICT";
}

test("a SayError out of a procedure answers with its code and its message, however deep it was thrown", async () => {
  const at = { context: {} as never, path: ["said"] };
  const deep = async (error: Error) => {
    await Promise.resolve();
    throw error;
  };
  const failing = (error: Error) => base.handler(() => deep(error));
  const tooMany = call(failing(new PackageError("skills.package.tooManyFiles", undefined, { max: 3 })), undefined, at);
  await expect(tooMany).rejects.toBeInstanceOf(ORPCError);
  await expect(tooMany).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: english("skills.package.tooManyFiles", { max: 3 }),
    data: { key: "skills.package.tooManyFiles", values: { max: 3 } },
  });
  await expect(call(failing(new Taken("skills.nameTaken", { name: "triage" })), undefined, at)).rejects.toMatchObject({
    code: "CONFLICT",
    data: { key: "skills.nameTaken", values: { name: "triage" } },
  });
  // Anything else goes on as it was: oRPC answers it as an internal error.
  await expect(call(failing(new Error("boom")), undefined, at)).rejects.toThrow("boom");
});
