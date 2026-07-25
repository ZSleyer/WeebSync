# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security > Report a vulnerability** on
this repository. That opens a private advisory only the maintainer can see. Do
not open a public issue for a security problem.

Expect a first reply within a few days. This is a spare-time project, so there
is no guaranteed response time and no bug bounty.

## Supported versions

Only the current `main` and the `:nightly` image built from it. There is no
backporting to older tags.

## What this app touches

Worth knowing when judging a finding:

- It stores **S/FTP credentials**, encrypted at rest with a key in
  `secret.key` beside the database. Anyone who has both files has the
  credentials, so a path traversal or an arbitrary file read is serious here.
- It authenticates users **locally or via OIDC**, and issues session cookies.
- It **writes to the filesystem** at paths the user configures, restricted to
  the roots in `WEEBSYNC_DOWNLOADS`.
- It talks to **third-party metadata APIs** (AniList, TMDB, TVDB, Plex) with
  tokens the user supplies.

## Hardening the deployment

- Put it behind a reverse proxy with TLS and set `force_https`, so session
  cookies carry `Secure`.
- Set `WEEBSYNC_DOWNLOADS` to the narrowest set of directories that works.
- Back up `secret.key` separately from the database; losing it costs every
  stored credential, leaking it costs the same.
