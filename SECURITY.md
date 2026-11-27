# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting (the repository's
Security tab, "Report a vulnerability"). Please don't open a public issue or post about it
before we answer. We acknowledge reports within a few days.

## Scope

This repository: Dispand's web app, API, runner and the reference deployment in `deploy/`.

## Security model

What Dispand must never do, and what keeps it so. Keep this list true: a pull request that
changes it updates this file.

**Who it defends against:** anyone on the internet calling the API or loading the app, and a
signed-in user trying to reach rows that aren't the session owner's. **Not defended against:** an operator with
access to the host, its database or the server's environment. Keep both lists true as the product grows: a reviewer
judges a finding by whether its attacker is in the first list.

A change that weakens any of these is a vulnerability.

## Supported versions

Only `main`.
