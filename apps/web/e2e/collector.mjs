// A stand-in OpenTelemetry collector for the browser tests: it keeps every OTLP/HTTP export it
// receives (JSON) and gives them all back on `GET /dump`, so a test can check what Dispand sent;
// `GET /has?text=` says whether any of them holds `text`.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";
import { gunzipSync } from "node:zlib";

const PORT = Number(process.env.COLLECTOR_PORT ?? 3199);
const received = [];

createServer((req, res) => {
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json");
    // `/has?text=`: whether anything received holds `text`, without sending it all back: a test
    // polling `/dump` would serialize the whole suite's exports each time and keep the exporters
    // waiting until they time out and drop their batches.
    const url = new URL(req.url, "http://collector");
    const text = url.searchParams.get("text");
    res.end(url.pathname === "/dump" ? JSON.stringify(received) : url.pathname === "/has" ? JSON.stringify(text !== null && received.some((r) => r.body.includes(text))) : "{}");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    received.push({ path: req.url, body: body.toString("utf8") });
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
}).listen(PORT, "127.0.0.1");
