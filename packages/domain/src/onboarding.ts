import { count, eq } from "drizzle-orm";
import { findAssistant } from "./agents/builtin.ts";
import { harnesses } from "./db/schema.ts";
import { authed, base } from "./rpc/context.ts";

const owner = base.use(authed);

/**
 * What first launch needs: the owner's Assistant, if it was made, and whether a harness exists
 * for it to run on. Until there is an Assistant, Home sends the owner to its page.
 */
const status = owner.handler(async ({ context }) => {
  const [assistant, [row]] = await Promise.all([
    findAssistant(context.db, context.ownerId),
    context.db.select({ n: count() }).from(harnesses).where(eq(harnesses.ownerId, context.ownerId)),
  ]);
  return { assistant: assistant && { agentId: assistant.agentId }, hasHarness: (row?.n ?? 0) > 0 };
});

export const onboarding = { status };
