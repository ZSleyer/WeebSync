# Development

## Run it locally

```bash
cd backend && go run .            # API on :8080, key auto-generated at ./data/secret.key
cd frontend && yarn && yarn dev   # Vite dev server, proxies /api to the backend
```

The frontend pins Yarn 4 in `frontend/.yarn/releases`; any `yarn` on the
PATH, a global 1.x included, hands over to it. New package versions install
only once they are a week old (`npmMinimalAgeGate` in `.yarnrc.yml`).

### Testing on a phone

`go build -tags mobiledebug .` adds two buttons to every page: **diag** shows
the device's viewport, safe-area and layout measurements, **upload** sends
screenshots picked from the photo library. Measurements are also posted on
every page change; reports and screenshots land in `<data>/mobile-debug/`.
The binary logs a warning at start. Never deploy it: images and releases
are built without the tag, and CI checks the image for it.

## The image

The runtime image is [distroless](https://github.com/GoogleContainerTools/distroless) on Debian 13 (glibc): the Go binary is static, but ffmpeg is not, and NVIDIA's container runtime injects glibc driver libraries a musl image cannot load. ffmpeg comes from Debian's own source package (`apt-get source ffmpeg`, so the archive's patches and security fixes come with every rebuild), configured in the `ffmpeg` stage of the `Dockerfile` for what the player uses: all native demuxers, decoders and filters, libx264, libass, libdav1d, VA-API, the NVENC headers (the driver itself comes from the host at run time) and the `lavfi` input for the encoder probe. Network is off except the `http` and `tcp` protocols the player's loopback listener needs for remote sources; every run also passes `-protocol_whitelist` and `-format_whitelist`. `ffmpeg -protocols` lists what is in. The `rootfs` stage copies exactly the libraries `ldd` reports for ffmpeg, ffprobe and the VA-API drivers and fails the build on a `not found`. If the player starts using a protocol or codec library that is missing, add it to the `configure` line.

Sizes: the amd64 image is about 325 MB, 120 MB with `--build-arg VAAPI_AMD=0`; arm64 is about 106 MB.

The image has no shell and no package manager. To look inside, use a throwaway container:

```bash
# a shell with the data volume next to the real thing
docker run --rm -it --entrypoint "" -v weebsync_data:/data debian:trixie-slim bash
# run the image's own ffmpeg/ffprobe
docker run --rm --entrypoint /usr/local/bin/ffmpeg ghcr.io/zsleyer/weebsync:nightly -encoders
# take the filesystem out to poke at it
docker create --name ws-look ghcr.io/zsleyer/weebsync:nightly && docker cp ws-look:/ ./rootfs && docker rm ws-look
```

`docker compose exec weebsync /weebsync reset-password ...` still works, it needs no shell.

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

### Third-party licenses

The About page lists every third-party component the app ships, with its
license text: Go modules linked into the binary (go-licenses v2.0.1), the npm
packages that end up in the production bundle (a small Vite plugin in
`frontend/scripts/licenses.mjs` reads the bundle's module ids), and static
entries in `tools/licenses/data.json` (Go itself, the vendored Swagger UI,
the password list, the fonts, the DB-IP database). After a dependency
change, regenerate and commit the result:

```bash
tools/licenses/generate.sh        # writes frontend/src/licenses/{inventory,texts}.json
tools/licenses/generate.sh --check   # only the allowlist check
```

CI regenerates and fails on a diff. The check refuses any license outside
`tools/licenses/allowlist.json`; copyleft packages are allowed one by one
there, each with its exact license string and the reason. A Go package whose
license file go-licenses cannot place (the vendored RAR decoder) gets its
version and URL from `tools/licenses/go-overrides.json`.

## Stack

- **Backend:** Go with the standard `net/http`, `modernc.org/sqlite`, `pkg/sftp`, `jlaffaye/ftp`; release names are read by `internal/relname`
- **Frontend:** React, TypeScript, Vite, Tailwind v4, TanStack Query
- **Design system:** `design-system/`, the reusable package `fluid-lycoris` (theme CSS, Tailwind bridge, React components), built from the app's own toolchain

## Releases

Versions follow Home Assistant: `YEAR.MONTH.N`. A month's release is `.0`, each fix after it counts up (`2026.10.0`, `2026.10.1`, then `2026.11.0`).

Before tagging a `.0`:

- **Freeze.** The release commit has run as a release candidate (below) on a real instance for a few days. Only fixes land in that time, each one as the next candidate.
- **Checks.** `ci` (with the security scans) and CodeQL are green on that exact commit.
- **Upgrade.** Start the previous stable image on a copy of a real `/data`, stop it, start the release candidate on the same copy. It must migrate and come up. Do this on amd64 and arm64.
- **Notes.** The draft is up to date with every commit since its last stand. "Before you upgrade" names everything that breaks and asks to back up `/data` first: migrations only go forward, so going back to an older release means restoring that backup.

A release candidate is tagged like a release, with `-rc1`, `-rc2` … after the version: `git tag -s 2026.11.0-rc1 -m 2026.11.0-rc1 && git push origin 2026.11.0-rc1`. The workflow builds `:2026.11.0-rc1` and moves `:rc`, never `:2026.11` or `:latest`. Publish it as a pre-release (`gh release create 2026.11.0-rc1 --verify-tag --prerelease --notes-file …`): installs on stable keep ignoring it, an `:rc` install is told about the next candidate and the final release. The final `.0` is then tagged on the last candidate's commit.

Then:

1. Tag the commit, signed and without a `v`: `git tag -s 2026.11.0 -m 2026.11.0 && git push origin 2026.11.0`
2. The `release` workflow builds `:2026.11.0`, moves `:2026.11` and `:latest`, and attaches the SBOM and a signed provenance to the image.
3. Publish the drafted GitHub release for the tag - the update check in the app reads the latest GitHub release. With immutable releases switched on in the repository settings, a published release is locked: a broken release is fixed by the next `.N`, never by moving or reusing its tag. The notes stay editable, so add known problems there.
4. Watch the own instance for a day or two. Data loss or a security hole gets a `.N+1` right away.

A fix for an older month goes on a branch from that release's tag. To build a tag whose commit predates the current workflow, run `release` by hand with the tag; set *moving* to `no` for a release older than the newest, so `:latest` stays put.
