// A provider stand-in for the supervisor's model forwarder (`egress.test.ts`): echoes the
// headers a model operation arrived with, answers a redirect on demand, and holds a stream
// open on demand, telling whether that stream was closed.
import { createServer } from "node:http";

let held = "none";
createServer((req, res) => {
  if (req.method === "GET" && req.url === "/held") return res.end(held);
  if (req.headers["x-test-redirect"]) return res.writeHead(307, { location: "https://elsewhere.test/v1/messages" }).end();
  if (req.headers["x-test-hold"]) {
    held = "open";
    req.on("close", () => (held = "closed"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.write("event: ping\ndata: {}\n\n");
  }
  req.resume();
  req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: req.url, headers: req.headers })));
}).listen(8080, "0.0.0.0");
