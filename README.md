# Dispand

Status: Prototype

Dispand is an open-source, event-driven platform for running agents and automating work across
any business domain. See `docs/PRODUCT.md` for what it is and `docs/ARCHITECTURE.md` for how it
is built.

Self-hosting (Docker Compose behind your reverse proxy): `deploy/README.md`. Connecting mail:
`docs/services/gmail.md` and `docs/services/microsoft-365.md`.
Licensed under the Apache License 2.0 (`LICENSE`).

```sh
mise install      # Node and pnpm, at the versions in .mise.toml
pnpm install
pnpm run dev
```

## Contributing

Open a pull request against `main`, with a [Conventional Commits](https://www.conventionalcommits.org/)
title (`feat(web): ...`): it becomes the commit on `main`, and the changelog is generated from it.
Before pushing, run `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build`.
Pull requests are squash-merged through a merge queue, which runs the checks again on top of
`main`: a pull request needn't be up to date with `main`, only free of conflicts.
