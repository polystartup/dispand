import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Options = {
  /** It accepts a client metadata document's URL as a client id (without fetching it). */
  metadataDocuments?: boolean;
  /** It registers clients (RFC 7591). */
  registration?: boolean;
  /** A client it was given out of band, as an owner enters it. */
  client?: { id: string; secret: string };
  /** A refresh is answered `invalid_grant` (a revoked grant). */
  refusesRefresh?: boolean;
  /** Its metadata, or its token endpoint, redirects there instead of answering. */
  redirectMetadataTo?: string;
  redirectTokenTo?: string;
};

/** One request to the token endpoint, as the form it posted (and the Authorization header). */
type TokenRequest = { form: Record<string, string>; authorization?: string };

export type FakeAuthServer = {
  url: string;
  /** Every request's path, in order. */
  paths: string[];
  tokenRequests: TokenRequest[];
  /** What the authorization endpoint was asked. */
  authorizations: URLSearchParams[];
  /** Whether the MCP server should take `token`. */
  accepts(token: string): boolean;
  /** Every access token issued so far stops working (as on expiry). */
  expireAccessTokens(): void;
  close(): Promise<void>;
};

const read = async (req: IncomingMessage) => {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body;
};

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/**
 * A local OAuth 2.1 authorization server for tests (never a real one), on an ephemeral loopback
 * port: metadata (RFC 8414), the authorization endpoint (which answers at once, as a signed-in
 * user would), the token endpoint with PKCE (S256) and refresh-token rotation, and registration.
 */
export async function startFakeAuthServer(options: Options = {}): Promise<FakeAuthServer> {
  const paths: string[] = [];
  const tokenRequests: TokenRequest[] = [];
  const authorizations: URLSearchParams[] = [];
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource: string | null }>();
  const access = new Set<string>();
  const refresh = new Map<string, string>();
  const registered = new Set<string>();
  let issued = 0;

  const tokens = (clientId: string) => {
    issued++;
    const at = `at-${issued}-${randomBytes(8).toString("hex")}`;
    const rt = `rt-${issued}-${randomBytes(8).toString("hex")}`;
    access.add(at);
    refresh.set(rt, clientId);
    return { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: 3600 };
  };

  /** The client id of the request, checking the entered client's secret (basic or post). */
  const clientOf = (form: Record<string, string>, authorization: string | undefined): string | null => {
    let id = form.client_id;
    let secret = form.client_secret;
    if (authorization?.startsWith("Basic ")) {
      const [user, pass] = Buffer.from(authorization.slice(6), "base64").toString().split(":");
      id = decodeURIComponent(user ?? "");
      secret = decodeURIComponent(pass ?? "");
    }
    if (options.client && id === options.client.id) return secret === options.client.secret ? id : null;
    return id && (registered.has(id) || (options.metadataDocuments && id.startsWith("https://"))) ? id : null;
  };

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      paths.push(url.pathname);
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (options.redirectMetadataTo) return res.writeHead(302, { location: options.redirectMetadataTo }).end();
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(options.registration ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
          ...(options.metadataDocuments ? { client_id_metadata_document_supported: true } : {}),
        });
      }
      if (url.pathname === "/authorize") {
        authorizations.push(url.searchParams);
        const p = url.searchParams;
        const code = randomBytes(16).toString("hex");
        codes.set(code, { clientId: p.get("client_id") ?? "", challenge: p.get("code_challenge") ?? "", redirectUri: p.get("redirect_uri") ?? "", resource: p.get("resource") });
        const back = new URL(p.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", p.get("state") ?? "");
        return res.writeHead(302, { location: back.href }).end();
      }
      if (url.pathname === "/register" && req.method === "POST" && options.registration) {
        const body = JSON.parse(await read(req)) as Record<string, unknown>;
        const id = `reg-${randomBytes(4).toString("hex")}`;
        registered.add(id);
        return json(res, 201, { ...body, client_id: id });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await read(req)));
        tokenRequests.push({ form, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
        if (options.redirectTokenTo) return res.writeHead(307, { location: options.redirectTokenTo }).end();
        const client = clientOf(form, req.headers.authorization);
        if (!client) return json(res, 401, { error: "invalid_client" });
        if (form.grant_type === "authorization_code") {
          const grant = codes.get(form.code ?? "");
          codes.delete(form.code ?? "");
          const challenge = createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url");
          if (!grant || grant.clientId !== client || grant.challenge !== challenge || grant.redirectUri !== form.redirect_uri) return json(res, 400, { error: "invalid_grant" });
          return json(res, 200, tokens(client));
        }
        if (form.grant_type === "refresh_token") {
          const owner = refresh.get(form.refresh_token ?? "");
          if (options.refusesRefresh || owner !== client) return json(res, 400, { error: "invalid_grant" });
          refresh.delete(form.refresh_token!);
          return json(res, 200, tokens(client));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url: base,
    paths,
    tokenRequests,
    authorizations,
    accepts: (token) => access.has(token),
    expireAccessTokens: () => access.clear(),
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** A server that only counts what reaches it: where a redirect would lead. */
export async function startRecorder(): Promise<{ url: string; requests: { path: string; headers: IncomingMessage["headers"]; body: string }[]; close(): Promise<void> }> {
  const requests: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const http = createServer((req, res) => {
    void read(req).then((body) => {
      requests.push({ path: req.url ?? "/", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
