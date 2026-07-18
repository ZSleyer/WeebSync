-- TOTP second factor for password/hybrid users. secret_enc is AES-GCM encrypted
-- (internal/secret); confirmed_at NULL means enrollment started but not verified.
CREATE TABLE user_totp (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc   BLOB NOT NULL,
    confirmed_at TEXT
);

-- One-time recovery codes (sha256 at rest); used_at set when redeemed.
CREATE TABLE user_recovery_codes (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT
);
CREATE INDEX idx_recovery_user ON user_recovery_codes(user_id);

-- Short-lived token bridging a correct password and the second-factor step, so
-- the password is never re-sent. token_hash = sha256(token); single-use.
CREATE TABLE login_pending (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
