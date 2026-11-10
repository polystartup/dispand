import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { Agent, fetch as undiciFetch } from "undici";

/** A tool URL that leads to one of Dispand's own addresses. Carries only the host. */
export class BlockedAddressError extends Error {
  override name = "BlockedAddressError";
  constructor(readonly host: string) {
    super(`${host} is one of Dispand's own addresses`);
  }
}

/**
 * The addresses of Dispand itself, which tool calls must not reach: loopback, unspecified and
 * link-local addresses (cloud metadata included), and every subnet of the app's own network
 * interfaces. In the container that is the Compose network, where PostgreSQL listens; the rest
 * of the host's network stays reachable.
 */
export function ownAddresses(interfaces = networkInterfaces()): BlockList {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const prefix = Number(entry.cidr?.split("/")[1]);
      if (Number.isInteger(prefix)) list.addSubnet(entry.address, prefix, entry.family === "IPv4" ? "ipv4" : "ipv6");
    }
  }
  return list;
}

const blockedIp = (blocked: BlockList, ip: string) => blocked.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/**
 * A `fetch` that never connects to an address in `blocked`. Names are checked on the addresses
 * the connection is made to (the lookup the socket uses, so a name can't resolve to another
 * address afterwards), and IP literals before connecting. Redirects aren't followed here: the MCP
 * transport follows same-origin ones itself, through this fetch again.
 */
export function guardedFetch(blocked: BlockList): typeof fetch {
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      if (addresses.length === 0 || addresses.some((a) => blockedIp(blocked, a.address))) return callback(new BlockedAddressError(hostname));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
  const dispatcher = new Agent({ connect: { lookup } as never });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host) && blockedIp(blocked, host)) throw new BlockedAddressError(host);
    return (await undiciFetch(input as never, { ...(init as object), redirect: "manual", dispatcher } as never)) as unknown as Response;
  }) as typeof fetch;
}
