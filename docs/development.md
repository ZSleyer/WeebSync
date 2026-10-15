# Development

## Run it locally

```bash
cd backend && go run .            # API on :8080, key auto-generated at ./data/secret.key
cd frontend && yarn && yarn dev   # Vite dev server, proxies /api to the backend
```

The frontend pins Yarn 4 in `frontend/.yarn/releases`; any `yarn` on the
PATH, a global 1.x included, hands over to it. New package versions install
only once they are a week old (`npmMinimalAgeGate` in `.yarnrc.yml`).

## Checks

CI runs the same steps; run them before you push.

```bash
cd backend
gofmt -l .                        # must print nothing
go vet ./... && go test -race ./...
golangci-lint run ./...
./gen-docs.sh && git diff --exit-code docs/   # OpenAPI spec in sync

cd frontend
yarn lint && yarn format:check && yarn test && yarn build
```

## Stack

- **Backend:** Go with the standard `net/http`, `modernc.org/sqlite`, `pkg/sftp`, `jlaffaye/ftp`, `anitogo`
- **Frontend:** React, TypeScript, Vite, Tailwind v4, TanStack Query
- **Design system:** `design-system/`, the reusable package `fluid-lycoris` (theme CSS, Tailwind bridge, React components), built from the app's own toolchain

## Releases

Versions follow Home Assistant: `YEAR.MONTH.N`. A month's release is `.0`, each fix after it counts up (`2026.10.0`, `2026.10.1`, then `2026.11.0`).

1. Tag the commit, signed and without a `v`: `git tag -s 2026.11.0 -m 2026.11.0 && git push origin 2026.11.0`
2. The `release` workflow builds `:2026.11.0`, moves `:2026.11` and `:latest`.
3. Publish a GitHub release for the tag with notes - the update check in the app reads the latest GitHub release.

A fix for an older month goes on a branch from that release's tag. To build a tag whose commit predates the current workflow, run `release` by hand with the tag; set *moving* to `no` for a release older than the newest, so `:latest` stays put.
