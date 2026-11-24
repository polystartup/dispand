#!/usr/bin/env bash
# Installs a Dispand runner on a Debian or Ubuntu VM: Docker and gVisor from their official
# repositories, then the runner's supervisor container, which restarts always. Run it as root,
# as the VM's user data or by hand; running it again changes nothing. It holds no secret and no
# server address: you pair the runner afterwards, in an SSH or console session.
set -euo pipefail

image=ghcr.io/polystartup/dispand-runner:latest
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" != 0 ]; then echo "cloud-init.sh: run it as root" >&2; exit 1; fi
# shellcheck source=/dev/null
. /etc/os-release
case "$ID" in debian | ubuntu) ;; *) echo "cloud-init.sh: Debian or Ubuntu only, not $ID" >&2; exit 1 ;; esac
arch="$(dpkg --print-architecture)"
# shortcut: the runner images are amd64 only; drop this once they're multi-arch.
if [ "$arch" != amd64 ]; then echo "cloud-init.sh: the runner image is amd64 only, not $arch" >&2; exit 1; fi

# Adds an apt repository signed by the key at <key url>: <name> <key url> <repository>.
add_repo() {
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "$2" -o "/etc/apt/keyrings/$1.asc"
  echo "deb [arch=$arch signed-by=/etc/apt/keyrings/$1.asc] $3" >"/etc/apt/sources.list.d/$1.list"
  apt-get update
}

if ! command -v docker >/dev/null; then
  add_repo docker "https://download.docker.com/linux/$ID/gpg" \
    "https://download.docker.com/linux/$ID ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable"
  apt-get install -y docker-ce docker-ce-cli containerd.io
fi
systemctl enable --now docker

if ! command -v runsc >/dev/null; then
  add_repo gvisor https://gvisor.dev/archive.key "https://storage.googleapis.com/gvisor/releases release main"
  apt-get install -y runsc
fi
if ! docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  runsc install
  # A reload registers the runtime without restarting running containers.
  systemctl reload docker
fi

# The supervisor alone gets the Docker socket (root on this host) and its group, to start one
# worker per conversation; its state (pairing, CLI logins, model keys) is the dispand-runner
# volume. DISPAND_HOST_ADDRESSES: this host's own addresses, which workers must not reach and a
# container can't see.
if ! docker container inspect dispand-runner >/dev/null 2>&1; then
  docker run -d --name dispand-runner --restart always \
    -v dispand-runner:/var/lib/dispand-runner \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --group-add "$(stat -c %g /var/run/docker.sock)" \
    -e DISPAND_HOST_ADDRESSES="$(hostname -I)" \
    "$image" >/dev/null
fi

cat <<'EOF'
The Dispand runner is installed and waits to be paired. In Dispand, add a runner to get a
pairing code, then pair it from an SSH or console session on this machine:

  sudo docker exec -it dispand-runner dispand-runner pair --server https://<your Dispand> --root /var/lib/dispand-runner/work

It asks for the code. Then set the provider API key its workers use (anthropic or openai; it
asks for the key), and restart the runner:

  sudo docker exec -it dispand-runner dispand-runner model-key anthropic
  sudo docker restart dispand-runner
EOF
