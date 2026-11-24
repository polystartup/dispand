// A worker's only route out: a listener of the supervisor on a network that holds just that
// worker and the supervisor. It tunnels (CONNECT) to an address only after checking every
// address the name resolves to, and forwards a provider's model operations with the runner's
// own key (D1), which the worker never holds. It closes, with every connection through it,
// when the worker ends.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
// undici 7, not 8: 8 needs Node 22.19, and the bare install runs on any Node 22.
import { Agent, fetch as undiciFetch } from "undici";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type LookupFunction, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PROXY_PORT = 3128;
/** Labels every network a worker gets, as every worker: A4 finds what a previous run left behind by it. */
export const NETWORK_LABEL = "dispand.runner.worker";
/** Names the supervisor a worker or network belongs to: its sweep at start takes only its own. */
export const OWNER_LABEL = "dispand.runner.supervisor";

/** The providers whose model operations the supervisor forwards, with the header their key goes in. */
export const PROVIDERS = {
  anthropic: { origin: "https://api.anthropic.com", operations: ["/v1/messages", "/v1/messages/count_tokens"], auth: (key: string) => ({ "x-api-key": key }) },
  openai: { origin: "https://api.openai.com", operations: ["/v1/responses"], auth: (key: string) => ({ authorization: `Bearer ${key}` }) },
} as const;
export type Provider = keyof typeof PROVIDERS;
export type ModelKeys = Partial<Record<Provider, string>>;

/** Never forwarded from the worker: its own credentials, and what belongs to one hop. */
const DROPPED = new Set(["host", "connection", "keep-alive", "upgrade", "transfer-encoding", "content-length", "authorization", "x-api-key", "proxy-authorization", "proxy-connection", "cookie"]);

/**
 * Where no worker may connect, whatever name or form it uses: cloud metadata and other
 * host-only credential endpoints, loopback and link-local, the host (`hostAddresses`, which a
 * supervisor in a container can't see), and every network the supervisor itself is on (its
 * host's bridge, other containers, every other worker's network). Read at each connection.
 */
export function blockList(hostAddresses: string[] = []): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["168.63.129.16", 32], ["100.100.100.200", 32]] as const) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [["::", 128], ["::1", 128], ["fe80::", 10], ["fd00:ec2::254", 128], ["fd20:ce::254", 128]] as const) list.addSubnet(net, prefix, "ipv6");
  for (const address of hostAddresses) list.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (!entry?.cidr) continue;
    const [net, prefix] = entry.cidr.split("/");
    list.addSubnet(net!, Number(prefix), entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return list;
}

/** Whether `address` is refused, an IPv4-mapped IPv6 address (any notation) checked as the IPv4 address it is. */
export function refused(list: BlockList, address: string): boolean {
  if (isIP(address) !== 6) return list.check(address, "ipv4");
  // The URL parser writes every IPv6 notation one way: `::ffff:a9fe:a9fe` for a mapped address.
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return list.check([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."), "ipv4");
  }
  return list.check(address, "ipv6");
}

/**
 * A `fetch` for destinations the supervisor is sent to (a tool's URL): every address a socket
 * resolves to is checked as a worker's CONNECT is, at each connection, so a name that changes
 * after a first check reaches nothing refused. IP literals don't resolve: `checkDestination` first.
 */
export function guardedFetch(hostAddresses: HostAddresses): typeof fetch {
  const lookup: LookupFunction = (host, options, callback) => {
    const done = callback as (err: Error | null, address: string | LookupAddress[], family?: number) => void;
    dnsLookup(host, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return done(err, []);
      // The host's addresses as they are now, at each connection.
      hostAddresses().then((hosts) => {
        const list = blockList(hosts);
        if (addresses.length === 0 || addresses.some((a) => refused(list, a.address))) return done(new Error(`the address of ${host} is refused on this runner`), []);
        if (options.all) done(null, addresses);
        else done(null, addresses[0]!.address, addresses[0]!.family);
      }, () => done(new Error(`the host's addresses can't be read: ${host} is refused on this runner`), []));
    });
  };
  const agent = new Agent({ connect: { lookup } });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}

/** The host's own addresses now; rejects when they can't be read (every check then refuses). */
export type HostAddresses = () => Promise<string[]>;

/** Prints the addresses of the network it runs in, once per line it reads; exits with its stdin. */
const HOST_HELPER = 'const os = require("node:os"); require("node:readline").createInterface({ input: process.stdin }).on("line", () => process.stdout.write(JSON.stringify(Object.values(os.networkInterfaces()).flat().map((a) => a.address)) + "\\n")).on("close", () => process.exit(0));';

/**
 * The host's addresses as they are at each check: `fixed` (`DISPAND_HOST_ADDRESSES`, for a
 * Docker whose network isn't the machine's), and what a helper on the host's network sees. A
 * supervisor in a container can't see them itself. The helper is the supervisor's own code in
 * the worker image (runc, non-root, read-only, no capability), started once, asked one at a time,
 * and started again at the next check after it died. No answer refuses the check: nothing is remembered.
 */
export function hostAddressesFrom(o: { image: string; owner: () => Promise<string>; fixed: string[]; docker?: string }): HostAddresses {
  const docker = o.docker ?? "docker";
  // A malformed entry refuses every check: it never quietly drops out of the list.
  const malformed = o.fixed.find((a) => isIP(a) === 0);
  let helper: Promise<ChildProcessWithoutNullStreams> | undefined;
  /** Whether the running helper has answered once: its first answer may wait for the image to be pulled. */
  let answered = false;
  let waiting: ((line: string) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const start = async () => {
    const env = { PATH: process.env.PATH, ...Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "HOME"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))) };
    // Where Docker's network isn't the machine's (rootless, Docker Desktop), the helper can't see the machine's addresses: the list must give them.
    const info = (await run(docker, ["info", "--format", "{{json .SecurityOptions}} {{.OperatingSystem}}"], { env })).stdout;
    if ((/rootless/.test(info) || /Docker Desktop/.test(info)) && o.fixed.length === 0) {
      throw new Error("this Docker's network isn't the machine's: DISPAND_HOST_ADDRESSES must list the machine's addresses");
    }
    answered = false;
    const child = spawn(docker, [
      "run", "-i", "--rm", "--runtime", "runc", "--network", "host", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${process.getuid!()}:${process.getgid!()}`, "--label", `${OWNER_LABEL}=${await o.owner()}`, o.image, "node", "-e", HOST_HELPER,
    ], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    let buffer = "";
    child.stdout.on("data", (d: Buffer) => {
      buffer += d;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        waiting?.(line);
      }
    });
    child.stdin.on("error", () => undefined);
    // A docker client that can't start (missing, not executable) fails the check, and the next one tries again.
    const gone = () => {
      helper = undefined;
      waiting?.("");
    };
    child.once("error", gone);
    child.once("exit", gone);
    return child;
  };
  const once = async (): Promise<string[]> => {
    if (malformed !== undefined) throw new Error(`DISPAND_HOST_ADDRESSES holds ${malformed}, which isn't an address`);
    helper ??= start();
    const child = await helper.catch((err: unknown) => {
      helper = undefined;
      throw err;
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = undefined;
        child.kill();
        reject(new Error("the host's addresses didn't come"));
      }, answered ? 10_000 : 300_000);
      waiting = (line) => {
        clearTimeout(timer);
        waiting = undefined;
        answered = true;
        try {
          const seen = (JSON.parse(line) as unknown[]).filter((a): a is string => typeof a === "string" && isIP(a) !== 0);
          if (seen.length === 0) throw new Error("no address");
          resolve(seen);
        } catch {
          reject(new Error("the host's addresses can't be read"));
        }
      };
      child.stdin.write("\n");
    });
  };
  return async () => {
    const answer = queue.then(once, once);
    queue = answer.catch(() => undefined);
    return [...o.fixed, ...(await answer)];
  };
}

/** Refuses a destination the supervisor itself would be sent to (a tool's URL) as a worker's CONNECT would be. */
export async function checkDestination(url: URL, hostAddresses: HostAddresses): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  const list = blockList(await hostAddresses());
  if (addresses.length === 0 || addresses.some((a) => refused(list, a.address))) throw new Error(`the address of the MCP server at ${url.host} is refused on this runner`);
}

export type EgressOptions = {
  /** The worker's network name: created here, removed at close. */
  network: string;
  /** The supervisor it belongs to (`OWNER_LABEL`). */
  owner: string;
  keys: ModelKeys;
  /** The host's own addresses, read at each check (`hostAddressesFrom`). */
  hostAddresses: HostAddresses;
  /** Tests only: where each provider's operations go instead of its own origin. */
  origins?: Partial<Record<Provider, string>>;
  /**
   * A personal worker's model relay (`subscriptions/relay.ts`): served instead of the proxy and the
   * runner's model forwarder, so the worker's only transport is that relay (no CONNECT, no key).
   */
  relay?: (req: IncomingMessage, res: ServerResponse) => void;
  docker?: string;
};

export type Egress = {
  /** What the worker's CLIs get: the proxy, and each provider's base URL when its key is configured. */
  env: Record<string, string>;
  /** The base URL of a provider's forwarder for the worker, when its key is configured. */
  baseUrl(provider: Provider): string | undefined;
  /** Where the worker reaches the supervisor's listener: the relay's base URL for a personal worker. */
  origin: string;
  close(): Promise<void>;
};

/**
 * The worker's model route: a configured provider's model operations only, to that provider's
 * origin, with the runner's key in place of whatever the worker sent, never following a redirect.
 * Each request's abort is in `aborts` while it runs, so the route's end cuts it.
 */
export function modelForwarder(keys: ModelKeys, aborts: Set<AbortController>, origins?: Partial<Record<Provider, string>>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://worker");
    } catch {
      return void res.writeHead(400).end();
    }
    const [, name = "", ...rest] = url.pathname.split("/");
    const provider = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name as Provider] : undefined;
    const key = provider ? keys[name as Provider] : undefined;
    const path = `/${rest.join("/")}`;
    // Only a configured provider's model operations: nothing else is sent with its key.
    if (!provider || !key || req.method !== "POST" || !(provider.operations as readonly string[]).includes(path)) {
      return void res.writeHead(403).end();
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !DROPPED.has(k)) headers[k] = v;
    const abort = new AbortController();
    aborts.add(abort);
    res.once("close", () => abort.abort());
    try {
      const origin = origins?.[name as Provider] ?? provider.origin;
      const upstream = await fetch(`${origin}${path}${url.search}`, {
        method: "POST", headers: { ...headers, ...provider.auth(key) },
        body: Readable.toWeb(req) as ReadableStream, duplex: "half", redirect: "manual", signal: abort.signal,
      } as RequestInit);
      // Never followed: the key goes only to the provider's own origin.
      if (upstream.status >= 300 && upstream.status < 400) return void res.writeHead(502).end();
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => { if (!DROPPED.has(k) && k !== "content-encoding") out[k] = v; });
      res.writeHead(upstream.status, out);
      if (upstream.body) Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally {
      aborts.delete(abort);
    }
  };
}

/** The supervisor's own container, from its mounts: without it, no worker gets a route (or starts). */
export async function selfContainer(): Promise<string> {
  const mounts = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  const id = /\/containers\/([0-9a-f]{64})\//.exec(mounts)?.[1];
  if (!id) throw new Error("the runner's supervisor isn't in a container it can find: no worker starts");
  return id;
}

export async function openEgress(o: EgressOptions): Promise<Egress> {
  const docker = o.docker ?? "docker";
  // Without the host's addresses, the host would be reachable: no route opens until they can be read.
  await o.hostAddresses().catch(() => {
    throw new Error("the host's own addresses can't be read: no worker starts");
  });
  const dockerEnv = { PATH: process.env.PATH, ...Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "HOME"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))) };
  const self = await selfContainer();
  // Internal (no route out) and with no address of the host on it: only the supervisor and the worker.
  await run(docker, ["network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true", "--label", `${NETWORK_LABEL}=1`, "--label", `${OWNER_LABEL}=${o.owner}`, o.network], { env: dockerEnv });
  const sockets = new Set<Socket>();
  const aborts = new Set<AbortController>();
  const server = createServer(o.relay ?? modelForwarder(o.keys, aborts, o.origins));
  const removeNetwork = async () => {
    await run(docker, ["network", "disconnect", "-f", o.network, self], { env: dockerEnv }).catch(() => undefined);
    await run(docker, ["network", "rm", o.network], { env: dockerEnv }).catch(() => undefined);
  };
  let address: string;
  try {
    await run(docker, ["network", "connect", o.network, self], { env: dockerEnv });
    address = (await run(docker, ["inspect", "-f", `{{(index .NetworkSettings.Networks "${o.network}").IPAddress}}`, self], { env: dockerEnv })).stdout.trim();
    if (isIP(address) !== 4) throw new Error(`the supervisor got no address on ${o.network}`);
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(PROXY_PORT, address, resolve));
  } catch (err) {
    server.close();
    await removeNetwork();
    throw err;
  }
  server.on("connection", (s) => track(s));
  // A personal worker gets no tunnel: with no listener, a CONNECT is answered by closing its socket.
  if (!o.relay) server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => void tunnel(req, client, head));

  function track(s: Socket) {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  }

  async function tunnel(req: IncomingMessage, client: Socket, head: Buffer) {
    // Before any await: a worker resetting the connection mid-lookup must not throw in the supervisor.
    client.on("error", () => client.destroy());
    const deny = (status: string) => client.end(`HTTP/1.1 ${status}\r\n\r\n`);
    const target = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(req.url ?? "");
    const host = target?.[1] ?? target?.[2];
    const port = Number(target?.[3]);
    if (!host || !(port > 0 && port < 65536)) return deny("400 Bad Request");
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      return deny("502 Bad Gateway");
    }
    // Every address the name has is checked, and the one connected to is one of them: no second lookup.
    // The host's addresses as they are now: an address it gained after start is refused too.
    let list: BlockList;
    try {
      list = blockList(await o.hostAddresses());
    } catch {
      return deny("502 Bad Gateway");
    }
    if (addresses.length === 0 || addresses.some((a) => refused(list, a.address))) return deny("403 Forbidden");
    const upstream = connect({ host: addresses[0]!.address, port });
    track(upstream);
    const end = () => { upstream.destroy(); client.destroy(); };
    upstream.once("error", () => (upstream.readyState === "opening" ? deny("502 Bad Gateway") : end()));
    client.on("error", end);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  const proxy = `http://${address}:${PROXY_PORT}`;
  const baseUrl = (provider: Provider) => (!o.relay && o.keys[provider] ? `${proxy}/${provider}` : undefined);
  const env: Record<string, string> = o.relay ? {} : { HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: address, no_proxy: address };
  // The CLI needs a key to send: the supervisor replaces it with the runner's.
  if (!o.relay && o.keys.anthropic) Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl("anthropic")!, ANTHROPIC_API_KEY: "dispand-supervisor" });
  return {
    env,
    baseUrl,
    origin: proxy,
    async close() {
      for (const a of aborts) a.abort();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await removeNetwork();
    },
  };
}
