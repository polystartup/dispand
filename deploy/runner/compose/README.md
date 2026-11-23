# A runner with Docker Compose

`compose.yaml` runs the runner's supervisor on any Linux host or NAS with Docker Compose. It
publishes no port: the runner connects out to Dispand. Its state (pairing, CLI logins) is the
`dispand-runner` volume.

The supervisor gets the Docker socket, which is root on this host, to start one worker per
conversation; nothing else does. Install gVisor (`runsc`) and register it with Docker for
every session mode (`cloud-init.sh` in the folder above shows how). Without it, the runner runs
only the modes verified under Docker's default runtime and refuses the others.

## Run it

From this folder:

```sh
export DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
docker compose pull
docker compose up -d
```

Run them again to update; the volume keeps the pairing.

## Pair it

In Dispand, add a runner to get a pairing code, then:

```sh
docker compose exec runner dispand-runner pair --server https://<your Dispand> --root /var/lib/dispand-runner/work
```

It asks for the code (never pass it on the command line). The running supervisor connects as
soon as it is paired, without a restart.

Remove it: `docker compose down --volumes`, then revoke the runner in Dispand.
