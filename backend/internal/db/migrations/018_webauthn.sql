-- Stable per-user WebAuthn handle (opaque 32 bytes), lazily set on first
-- credential registration.
ALTER TABLE users ADD COLUMN webauthn_handle BLOB;

-- WebAuthn credentials. cred_json is the go-webauthn Credential serialized whole
-- (public key, sign count, transports…); credential_id is cred.ID for lookup.
-- passwordless=1: a discoverable passkey usable for primary login;
-- passwordless=0: a roaming security key (YubiKey) used only as a second factor.
CREATE TABLE webauthn_credentials (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id BLOB NOT NULL UNIQUE,
    cred_json     BLOB NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    passwordless  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used     TEXT
);
CREATE INDEX idx_webauthn_user ON webauthn_credentials(user_id);
