# TV devices

A TV launcher (or any other read-only client) can show your WeebSync
calendar and recent downloads. It pairs with your account by a short code,
the way TVs sign in to streaming apps, after the OAuth 2.0 device
authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)).

## Pairing a device

1. The device asks WeebSync for a pairing and shows a code such as
   `WDJB-MJHT`.
2. In WeebSync open Settings → Account → **Devices**, type the code and
   choose *Link device*.
3. The device receives its token and starts showing your data.

Only type a code your own device shows right now: whoever enters a code links
that device to their account. The panel also lists your devices with their
last use, and *Revoke* cuts one off at once.

## API for device developers

Every body is JSON (`Content-Type: application/json`). Errors are
`{"error": "<code>"}`.

### 1. Start: `POST /api/devices/pair`

No authentication. Body optional: `{"name": "Kotatsu"}`.

```json
{"userCode": "WDJB-MJHT", "deviceCode": "<64 hex>", "expiresAt": 1792890000, "interval": 5}
```

Show `userCode`; keep `deviceCode` secret. Both expire at `expiresAt` (unix
seconds, about 10 minutes). `429` when the address pairs too often.

### 2. Poll: `POST /api/devices/token`

No authentication. Body: `{"deviceCode": "<deviceCode>"}`. Wait `interval`
seconds between requests.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"token": "<64 hex>", "scope": "tv:read"}` | Approved. Returned once; the device code is used up. |
| 400 | `{"error": "authorization_pending"}` | Not approved yet. Keep polling. |
| 400 | `{"error": "slow_down", "interval": 10}` | Polled too fast. Use the new interval from now on. |
| 400 | `{"error": "access_denied"}` | The user declined. Stop. |
| 400 | `{"error": "expired_token"}` | The pairing ran out. Stop; start a new one when the user asks. |
| 400 | `{"error": "invalid_grant"}` | Unknown or already used device code. Stop. |
| 400 | `{"error": "invalid_request"}` | No device code sent. |
| 429 | `{"error": "…"}`, `Retry-After` | Too many requests from this address. |

### 3. Read: `/api/tv/*`

Send `Authorization: Bearer <token>`. The token works on these routes only.
`401` means the token is unknown, revoked, or its account is gone or not
approved: pair again. `403` means the account must first replace its password
or passkey in the browser.

`GET /api/tv/calendar?days=7` - your watches' episode slots from 6 hours ago
to `days` ahead (1..14, default 7), sorted by `airingAt`:

```json
[{"watchId": 12, "anilistId": 154587, "title": "Frieren", "episode": 14, "episodeAbs": 42,
  "airingAt": 1792890000, "dub": false, "estimated": false, "have": true,
  "posterUrl": "https://…", "backdropUrl": "https://image.tmdb.org/t/p/w1280/…", "plexRatingKey": "4711"}]
```

`GET /api/tv/recent?limit=20` - your finished downloads, one entry per
episode, newest first (1..50, default 20):

```json
[{"watchId": 12, "title": "Frieren", "season": 1, "episode": 14, "finishedAt": 1792890000,
  "posterUrl": "https://…", "backdropUrl": "https://…", "plexRatingKey": "4711"}]
```

Optional fields (`anilistId`, `episodeAbs`, `posterUrl`, `backdropUrl`,
`plexRatingKey`, `watchId`, `season`, `episode` on recent) are left out when
unknown. Both lists come from cached data, so polling every 15 minutes is
cheap; a backdrop shows up once WeebSync has looked it up for the web UI.
