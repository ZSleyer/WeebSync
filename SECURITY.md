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

- First run: until the first account exists, registering and the provider
  setup need the setup code from the server log (or `WEEBSYNC_SETUP_TOKEN`).
- New accounts: anyone who signs themselves up - registration, open or
  not, or a first sign-in through the identity provider - waits for an
  admin's approval. Accounts an admin creates, the first account and provider
  identities whose groups make them admin need none.
- Passwords: at least 10 characters (counted as characters, NFC-normalised),
  no composition rules, checked against a list of common and breached
  passwords and against the account's own address. An account whose existing
  password fails these rules is held at a "set a new password" page after its
  next sign-in. Hashed with argon2id (64 MiB, t=3, p=4).
- Brute force: 5 attempts per address (per /64 for IPv6), then one per 12 s;
  10 failed passwords or second factors per account, then one per 5 minutes.
  Both refill instead of locking; a browser that signed in to the account
  before carries a signed device cookie and is not held by the account's
  limit, so a stranger cannot keep the owner out, and admin-configured
  trusted networks are exempt.
- Passkeys must verify the user (PIN or biometrics). A passkey registered
  before that rule which signs in without verification holds the account until
  it is replaced or removed. Adding a passkey, a security key or TOTP needs the
  account's password.
- Sessions: a random 256-bit token, stored hashed, `HttpOnly`,
  `SameSite=Lax`, `Secure` behind HTTPS. "Stay signed in" starts ticked and is
  remembered per browser; untick it on a shared computer. Without it the cookie
  ends with the browser session and the server ends it after 12 idle hours or
  24 hours at most. With it, the session slides with use: it ends after 30 idle
  days and 90 days at most. That is longer than the 30 days overall NIST
  suggests for AAL1; it is a deliberate trade for an app people open daily,
  bounded by server-side revocation, the session list in the account settings
  and a mail on every change to the sign-in factors.
- The account owner gets a mail (without links) whenever the password, TOTP,
  a passkey or a security key changes; adding or removing any of them needs
  the password.
- A sign-in from a browser the account has not used before (password, second
  factor, passkey, security key or single sign-on) is reported to the owner:
  by mail when a mail server is configured, otherwise by web push, with time,
  browser, address, approximate place (if enabled) and method. The mail
  carries no link; the push opens the account's session list.
  Browsers are recognised by a signed `weebsync_known` cookie (up to four
  accounts, 400 days, `/api/auth` only), separate from the rate limiter's
  device cookie so a password change does not make every browser new. The
  first sign-in of an account is not reported, and repeats from one address
  are collapsed to one notice per account and address every ten minutes; a
  new browser from another address is always reported.
- Cross-site requests: Go's `CrossOriginProtection` refuses state-changing
  browser requests from other origins, sibling subdomains included, on top of
  `SameSite` and the JSON-only API. The configured public address is trusted
  for older browsers that send only `Origin`; behind a proxy that rewrites the
  `Host` header over plain HTTP, set it.
- Least privilege: what reaches the shared library, the admin's Plex account
  or instance-wide settings (renaming, moving, deleting, replacing or
  restoring existing files in the media roots, replacing old copies, the
  local library's matches and rules, Plex track choices) is an admin's,
  enforced by the server whatever the UI shows. Creating new things under the
  roots (folders, new downloads that do not replace an existing file, watch
  targets) is allowed for every signed-in user. Creating a folder never overwrites or removes anything.

## Paired devices

Read-only devices (a TV launcher) pair after the OAuth 2.0 device
authorization grant, RFC 8628 (https://www.rfc-editor.org/rfc/rfc8628, read
2026-10-25):

- The user code is 8 letters of the RFC's base-20 set
  `BCDFGHJKLMNPQRSTVWXZ` (about 34.5 bits, section 6.1), drawn by rejection
  sampling; case, dashes and stray characters are ignored on entry. The
  device code and the token are 256 random bits. Only sha256 hashes of all
  three are stored.
- A pairing lives 10 minutes (section 5.4). The device polls at 5 s; faster
  polls answer `slow_down` and raise its interval by 5 s (section 3.5).
- Guessing codes (section 5.1): approving needs a signed-in account and
  counts against that account (5 tries, then one every 2 minutes, no
  trusted-network exemption, checked before the code is looked up) and the
  address (10, then 5 a minute). Starting a pairing and polling are limited
  per address. At most 5 pairings are open per address (IPv6: per /64) and
  20 per IPv6 /48, and 500 on the whole instance; at that cap the pairings
  silent longest past twice their own polling interval plus 5 s make room.
  Accepted gap: someone with about a hundred IPv4 addresses that keep polling
  can still hold the instance cap and block new pairings while they do. There is no list of
  pending pairings: only the code on the device binds it, to the account that
  types it.
- A token carries the scope `tv:read`, is accepted on `/api/tv/*` only (no
  other route reads it, and those routes take no session cookie), and reads
  only its own account's watches and downloads. It is looked up by its hash.
  Revoking it, deleting the account (the tokens go with it) or the account
  not being approved refuses it with 401. A new password (own or set by an
  admin), "end all other sessions" and an OIDC back-channel logout of the
  whole user (by subject) revoke the account's devices and approved pairings
  in the same transaction. A back-channel logout of one provider session (by
  sid) ends only that browser's login and leaves the devices paired. Last use and address are stamped at
  most once a minute and shown in the account's device list.
- The panel tells the user to enter only a code their own device shows
  (section 5.4, remote phishing). A device that leaks its token exposes the
  account's titles, schedule and download history, nothing else; revoke it
  in the device list.

## Outgoing connections

- TLS everywhere it applies: certificates and host names are verified
  against the system roots (add a private CA with `SSL_CERT_FILE` or
  `SSL_CERT_DIR`), TLS 1.2 at least, and there is no option to skip
  verification. FTPS encrypts the data channel as well as the control
  connection.
- SFTP host keys are pinned explicitly on first contact; the client offers no
  SHA-1 based algorithms and asks for the pinned key's type only.
- Redirects never go from HTTPS to HTTP, and drop `Authorization`, cookies,
  `X-Plex-Token` and `X-Api-Key` when they leave the origin.
- A URL that carries a credential (identity provider, AI endpoint, Plex, Home
  Assistant webhook) may be plain `http://` only for a host inside your own
  network (loopback, RFC 1918, IPv6 ULA). Mail with a login needs STARTTLS or
  TLS. Plain FTP stays possible for servers that offer nothing else, and the
  security review lists it.
- OIDC uses PKCE (S256) whenever the provider announces it. After an upgrade,
  sign in once through the provider to confirm it accepts the challenge.

## Supply chain

Frontend dependencies are pinned through `yarn.lock`, installed with
`--immutable`, a 7-day age gate (`npmMinimalAgeGate`) and install scripts off
(`enableScripts: false`); CI checks that every lockfile entry resolves through
the registry (`lockfile-lint`, a pinned devDependency).

Accepted risk: Yarn Berry stores no checksum in `yarn.lock` for platform
dependent packages (entries with `conditions:`, such as the native bindings of
rolldown, lightningcss, Tailwind oxide and the TypeScript compiler). A swapped
tarball for one of them is not detected; their integrity rests on TLS and on
the immutability of published npm versions. Yarn calls this a known limitation
(https://github.com/yarnpkg/berry/issues/6759, closed as not planned) and has
no setting that closes it: `checksumBehavior` only compares cache entries that
have an expected checksum, `enableHardenedMode` checks the lockfile against
registry metadata, and `supportedArchitectures` only chooses which platforms
get installed (https://yarnpkg.com/configuration/yarnrc, read 2026-10-24).
Revisit when Yarn stores checksums for these entries.

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
