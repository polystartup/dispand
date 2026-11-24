# A runner with Docker Compose

`compose.yaml` runs the runner's supervisor on any Linux host or NAS with Docker Compose. It
publishes no port: the runner connects out to Dispand. Its state (pairing, CLI logins, model
keys) is the `dispand-runner` volume.

The supervisor gets the Docker socket, which is root on this host, and its group, to start one
worker per conversation; nothing else does. It also needs the host's own addresses, which
workers must not reach and a container can't see. Install gVisor (`runsc`) and register it with Docker for
every session mode (`cloud-init.sh` in the folder above shows how). Without it, the runner runs
only the modes verified under Docker's default runtime and refuses the others.

## Run it

From this folder:

```sh
printf 'DOCKER_GID=%s\nDISPAND_HOST_ADDRESSES=%s\n' "$(stat -c %g /var/run/docker.sock)" "$(hostname -I)" > .env
docker compose pull
docker compose up -d
```

`.env` keeps both values for later Compose commands. The host needs addresses that don't change
(a static address or a DHCP reservation): if they do, write `.env` again and run
`docker compose up -d` at once, which recreates the runner with the new ones (a restart
doesn't). Run the last two commands again to update; the volume keeps the pairing and the
model keys.

## Pair it

In Dispand, add a runner to get a pairing code, then:

```sh
docker compose exec runner dispand-runner pair --server https://<your Dispand> --root /var/lib/dispand-runner/work
```

It asks for the code (never pass it on the command line). The running supervisor connects as
soon as it is paired, without a restart.

Then set the provider API key the workers use (`anthropic` or `openai`; it asks for the key),
and restart the runner:

```sh
docker compose exec runner dispand-runner model-key anthropic
docker compose restart runner
```

Remove it: `docker compose down --volumes`, then revoke the runner in Dispand.
