-- Device pairing after the OAuth 2.0 device authorization grant (RFC 8628):
-- a TV asks for a pairing, shows the user code, and polls with the device
-- code until a signed-in user types the user code in. Only hashes of both
-- codes are kept. user_id is set by the approval and binds the token that the
-- next poll hands out; the row goes when that poll takes it.
CREATE TABLE device_pairings (
    id               INTEGER PRIMARY KEY,
    device_code_hash TEXT NOT NULL UNIQUE,
    user_code_hash   TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL, -- unix seconds
    expires_at       INTEGER NOT NULL, -- unix seconds
    poll_interval    INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval > 0),
    last_poll_ms     INTEGER NOT NULL DEFAULT 0, -- unix milliseconds of the last token request, 0 = none yet
    ip               TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_device_pairings_expires ON device_pairings(expires_at);

-- The read-only tokens paired devices carry, by their sha256. A token belongs
-- to one user and goes with them.
CREATE TABLE device_tokens (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL DEFAULT '',
    scope        TEXT NOT NULL DEFAULT 'tv:read',
    created_at   TEXT NOT NULL, -- RFC 3339
    last_used_at TEXT NOT NULL DEFAULT '', -- RFC 3339, stamped at most once a minute; '' = never
    last_ip      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);
