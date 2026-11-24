#!/usr/bin/env bash
# A1's exit check, on a host with Docker: from an empty volume the supervisor image waits
# unpaired, `pair` run in the container pairs it against a test server, and the same container
# connects without a restart. Usage: image-exit-check.sh <supervisor image>
set -euo pipefail
image="$1"
name="dispand-runner-check-$$"
volume="$name"
port=18765
log="$(mktemp)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  [ -n "${server:-}" ] && kill "$server" 2>/dev/null || true
  rm -f "$log"
}
trap cleanup EXIT

# The test server: accepts the code CHECK2345, hands out a token, logs the WebSocket upgrade.
node -e '
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      if (req.url === "/runner/pair" && JSON.parse(body).code === "CHECK2345") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runnerId: "r_check", token: "t_check" }));
      } else res.writeHead(401).end();
    });
  });
  server.on("upgrade", (req, socket) => {
    console.log(`upgrade ${req.url} ${req.headers.authorization}`);
    socket.destroy();
  });
  server.listen(Number(process.argv[1]), "127.0.0.1");
' "$port" >"$log" &
server=$!
# Listening before the runner pairs against it: any HTTP answer will do.
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.2; done

# Host network: the test server is on the host's loopback, where the runner allows plain http.
docker run -d --name "$name" --network host -v "$volume:/var/lib/dispand-runner" "$image" >/dev/null
wait_for() { for _ in $(seq 60); do if eval "$1"; then return 0; fi; sleep 1; done; echo "timed out: $1" >&2; docker logs "$name" >&2; exit 1; }
wait_for 'docker logs "$name" 2>&1 | grep -q "not paired yet"'
echo CHECK2345 | docker exec -i "$name" dispand-runner pair --server "http://127.0.0.1:$port" --root /var/lib/dispand-runner/work
wait_for 'grep -q "upgrade /runner/ws Bearer t_check" "$log"'
[ "$(docker inspect -f '{{.RestartCount}} {{.State.Running}}' "$name")" = "0 true" ]
[ "$(docker exec "$name" id -u)" != 0 ]
echo "exit check passed: paired and connected without a restart"
