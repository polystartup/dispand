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
`dispand-runner` container, which restarts always. Its state (pairing, CLI logins, model
keys) is the `dispand-runner` volume. Running the script again changes nothing.

The supervisor gets the Docker socket, which is root on this machine, and its group, to start
the workers. Nothing else does: the workers never get it. Keep other workloads off this machine.
Workers never reach the machine's own addresses: the supervisor reads them at each check, so an
address the machine gains later is refused too.

The script runs the `latest` tag. That image is built and pushed only by this repository's
workflow on `main`, the branch the script itself comes from, so a tag can't run anything a
change to `main` couldn't. To hold a version, pull a `<version>` or `sha-<sha>` tag and
retag it as `latest` before running the script.

## Pair it

In Dispand, add a runner to get a pairing code. Then, in an SSH or console session on the
machine:

```sh
sudo docker exec -it dispand-runner dispand-runner pair --server https://<your Dispand> --root /var/lib/dispand-runner/work
```

It asks for the code (never pass it on the command line). The running supervisor connects as
soon as it is paired, without a restart.

Then set the provider API key the workers use (`anthropic` or `openai`; it asks for the key,
which the supervisor sends on the provider's model operations only and no worker holds), and
restart the runner:

```sh
sudo docker exec -it dispand-runner dispand-runner model-key anthropic
sudo docker restart dispand-runner
```

## Use your own Codex subscription

Instead of a model key, a person can run their own ChatGPT subscription on this runner, for the
Codex Jobs they start themselves. It works only under gVisor (`runsc`, which the script installs),
and only for Codex for now. Sign in over SSH or the machine's console, never through Dispand
(`--device-auth` shows a code to enter in your own browser):

```sh
sudo docker exec -it dispand-runner dispand-runner sign-in codex -- --device-auth
```

Then, in Dispand, open Settings, Harnesses, Runners, choose **Enroll my subscription** on this runner's card, and copy its
challenge. Confirm it on the machine (it asks for the challenge; never pass it on the command line):

```sh
sudo docker exec -it dispand-runner dispand-runner enroll codex
```

The login stays in the supervisor's own store: no worker ever holds it, and Dispand only receives
which person, runner and account are bound. Your hand-started Codex Jobs on this runner then use your
subscription; schedules, triggers and other people's Jobs use the runner's model key. When the card
says a fresh sign-in is needed, run `sign-in` again, then enroll again. Update the runner when you
update Dispand: a runner older than personal subscriptions refuses the Jobs placed on one.

## Update or remove it

Update to the latest image: `sudo docker pull ghcr.io/polystartup/dispand-runner:latest`,
`sudo docker rm -f dispand-runner`, then run `cloud-init.sh` again. The volume keeps the
pairing and the model keys.

Remove it: `sudo docker rm -f dispand-runner && sudo docker volume rm dispand-runner`, then
revoke the runner in Dispand.
