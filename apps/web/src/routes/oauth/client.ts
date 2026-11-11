import { createFileRoute } from "@tanstack/react-router";

// Dispand's OAuth client metadata document, its client id where an authorization server takes
// one: public, it holds only the app's name and callback address.
async function handle() {
  const [{ clientDocument }, { getApp }] = await Promise.all([import("@dispand/domain"), import("../../server/app.ts")]);
  return clientDocument((await getApp()).appUrl);
}

export const Route = createFileRoute("/oauth/client")({ server: { handlers: { GET: handle } } });
