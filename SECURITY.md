# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security > Report a vulnerability** on
this repository. That opens a private advisory only the maintainer can see. Do
not open a public issue for a security problem.

Expect a first reply within a few days. This is a spare-time project, so there
is no guaranteed response time and no bug bounty.

## Supported versions

Only the latest release (`:latest`), the current `main` and the `:nightly` image
built from it. There is no backporting to older tags.

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

## Security model

- Signed-in users are trusted members of one instance. Local media roots and
  the remote catalog are shared resources, not tenant-isolated storage.
- Local filesystem operations are confined with Go's `os.Root`. Relative
  symlinks may point elsewhere inside the same configured root; absolute links
  and links escaping that root are rejected.
- FTP is supported for compatibility but provides no transport encryption.
  Prefer SFTP or FTPS whenever the server supports either one.

## Sign-in and sessions

Measured against NIST SP 800-63B-4 and OWASP ASVS 5.0:

- Passwords: at least 10 characters (counted as characters, NFC-normalised),
  no composition rules, checked against a list of common and breached
  passwords and against the account's own address. An account whose existing
  password fails these rules is held at a "set a new password" page after its
  next sign-in. Hashed with argon2id (64 MiB, t=3, p=4).
- Brute force: 5 attempts per address (per /64 for IPv6), then one per 12 s;
  10 failed passwords or TOTP codes per account, then one per 5 minutes. Both
  refill instead of locking, so nobody can lock an owner out for good, and
  admin-configured trusted networks are exempt.
- Passkeys must verify the user (PIN or biometrics). A passkey registered
  before that rule which signs in without verification holds the account until
  it is replaced or removed. Adding a passkey, a security key or TOTP needs the
  account's password.
- Sessions: a random 256-bit token, stored hashed, `HttpOnly`,
  `SameSite=Lax`, `Secure` behind HTTPS. Without "stay signed in" the cookie
  ends with the browser session and the server ends it after 12 idle hours or
  24 hours at most. With it, the session slides with use: it ends after 30 idle
  days and 90 days at most. That is longer than the 30 days overall NIST
  suggests for AAL1; it is a deliberate trade for an app people open daily,
  bounded by server-side revocation, the session list in the account settings
  and a mail on every change to the sign-in factors.
- The account owner gets a mail (without links) whenever the password, TOTP,
  a passkey or a security key changes.

## Hardening the deployment

- Put it behind a reverse proxy with TLS and set `force_https`, so session
  cookies carry `Secure`.
- Configure `base_url` to the public HTTPS origin before enabling email
  verification; links are never derived from an untrusted request host.
- Set `WEEBSYNC_DOWNLOADS` to the narrowest set of directories that works.
- Back up `secret.key` separately from the database; losing it costs every
  stored credential, leaking it costs the same.
- Treat the database and `secret.key` as one security boundary. Encryption at
  rest protects either file in isolation, not an attacker who obtains both.
