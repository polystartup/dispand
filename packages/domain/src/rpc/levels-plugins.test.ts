import { call } from "@orpc/server";
import { expect, test } from "vitest";
import { lawFirmMarket, installReviewed } from "../plugins/test-support.ts";
import { ownerContext, personContext } from "../runners/test-support.ts";
import { router } from "./router.ts";

const forbidden = { code: "FORBIDDEN" };

test("levels › a member sees the workspace's plugins and marketplaces; only a manager installs, removes or changes them", async () => {
  const owner = { ...(await ownerContext()), gitFileUrls: true };
  const pat = { ...(await personContext(owner, "pat", "member")), gitFileUrls: true };
  const mia = { ...(await personContext(owner, "mia", "manager")), gitFileUrls: true };
  const fx = lawFirmMarket();
  try {
    await expect(call(router.marketplaces.add, { url: fx.repo.url }, { context: pat })).rejects.toMatchObject(forbidden);
    const market = await call(router.marketplaces.add, { url: fx.repo.url }, { context: mia });
    // Every member sees what the workspace has.
    expect((await call(router.marketplaces.list, undefined, { context: pat })).map((m) => m.id)).toContain(market.id);
    await expect(call(router.marketplaces.sync, { id: market.id }, { context: pat })).rejects.toMatchObject(forbidden);
    await expect(installReviewed(pat, { marketplaceId: market.id, entryName: "law-firm" })).rejects.toMatchObject(forbidden);
    const { pluginId } = await installReviewed(mia, { marketplaceId: market.id, entryName: "law-firm" });
    expect((await call(router.plugins.list, undefined, { context: pat })).map((p) => p.id)).toContain(pluginId);
    const { reviewed } = await call(router.plugins.uninstallPreview, { id: pluginId }, { context: pat });
    await expect(call(router.plugins.uninstall, { id: pluginId, reviewed, choices: {} }, { context: pat })).rejects.toMatchObject(forbidden);
    // Accepting or declining a conflict, Stem's merged value included, is a manager's, checked at each call.
    await expect(call(router.plugins.resolveConflict, { id: "conflict_any", choice: "accept", reviewed: "0".repeat(64) }, { context: pat })).rejects.toMatchObject(forbidden);
    await call(router.plugins.uninstall, { id: pluginId, reviewed, choices: {} }, { context: mia });
    await expect(call(router.marketplaces.remove, { id: market.id }, { context: pat })).rejects.toMatchObject(forbidden);
    await call(router.marketplaces.remove, { id: market.id }, { context: mia });
  } finally {
    fx.remove();
  }
});
