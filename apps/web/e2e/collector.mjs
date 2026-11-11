// A stand-in OpenTelemetry collector for the browser tests: it keeps every OTLP/HTTP export it
// receives (JSON) and gives them all back on `GET /dump`, so a test can check what Dispand sent.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import process from "node:process";
import { gunzipSync } from "node:zlib";

const PORT = Number(process.env.COLLECTOR_PORT ?? 3199);
const received = [];

createServer((req, res) => {
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/dump" ? JSON.stringify(received) : "{}");
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
