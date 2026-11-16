import { expect, test } from "vitest";
import { Route } from "./_app.settings.agents.$id.tsx";

test("the agent route takes a tab search parameter, so a run's back link can open Jobs", () => {
  const schema = Route.options.validateSearch as { safeParse: (search: unknown) => { success: boolean } };
  expect(schema.safeParse({ tab: "jobs" }).success).toBe(true);
  expect(schema.safeParse({ tab: "nope" }).success).toBe(false);
});
