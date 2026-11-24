// The helper on the host's network sees the host's own addresses, with no list given: a
// supervisor in a container reads them at each check, so an address the host gains is refused.
import { networkInterfaces } from "node:os";
import { describe, expect, test } from "vitest";
import { hostAddressesFrom } from "../../src/sandbox/egress.ts";

const IMAGE = process.env.DISPAND_SANDBOX_IMAGE;

describe.skipIf(!IMAGE)("the host's addresses", () => {
  test("are read from the host's own network, no list needed", async () => {
    const hosts = hostAddressesFrom({ image: IMAGE!, owner: async () => `test-hosts-${process.pid}`, fixed: [] });
    // Inside the supervisor (CI), the host's addresses are the VM's, given to the test only; on a host, its own interfaces.
    const expected = (process.env.DISPAND_HOST_ADDRESSES ?? "").split(/[\s,]+/).filter(Boolean);
    const own = expected.length ? expected : Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === "IPv4").map((a) => a!.address);
    const seen = await hosts();
    for (const address of own) expect(seen, address).toContain(address);
    // Asked again: the same helper answers, as it does at each check.
    expect(await hosts()).toEqual(seen);
  }, 120_000);
});
