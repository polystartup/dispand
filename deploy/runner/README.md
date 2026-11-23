# One-click runners

A runner runs Dispand's CLI sessions (Claude Code, Codex) on a machine you control. Here, it is
one container image, `ghcr.io/polystartup/dispand-runner` (the supervisor, see
[`apps/runner/README.md`](../../apps/runner/README.md)), which starts one sandboxed worker per
conversation. Every target below runs that image the same way, from `cloud-init.sh`.

Nothing here holds a secret or your server's address: user data can be read back through the
cloud provider's API, and a link lands in browser history. You pair the runner afterwards, in
an SSH or console session on the machine.

## Any cloud VM: `cloud-init.sh`

Give `cloud-init.sh` as the user data of a Debian or Ubuntu VM (amd64), on any provider that
runs cloud-init, or run it as root on such a machine:

```sh
curl -fsSL https://raw.githubusercontent.com/polystartup/dispand/main/deploy/runner/cloud-init.sh | sudo bash
```

It installs Docker (unless the machine has it) and gVisor (`runsc`) from their official
repositories, registers `runsc` with Docker, then starts the supervisor as the
`dispand-runner` container, which restarts always. Its state (pairing, CLI logins) is the
`dispand-runner` volume. Running the script again changes nothing.

The supervisor gets the Docker socket, which is root on this machine, to start the workers.
Nothing else does: the workers never get it. Keep other workloads off this machine.

## Pair it

In Dispand, add a runner to get a pairing code. Then, in an SSH or console session on the
machine:

```sh
sudo docker exec -it dispand-runner dispand-runner pair --server https://<your Dispand> --root /var/lib/dispand-runner/work
```

It asks for the code (never pass it on the command line). The running supervisor connects as
soon as it is paired, without a restart.

## Update or remove it

Update to the latest image: `sudo docker pull ghcr.io/polystartup/dispand-runner:latest`,
`sudo docker rm -f dispand-runner`, then run `cloud-init.sh` again. The volume keeps the
pairing.

Remove it: `sudo docker rm -f dispand-runner && sudo docker volume rm dispand-runner`, then
revoke the runner in Dispand.
