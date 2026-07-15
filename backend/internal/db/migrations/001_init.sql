CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL DEFAULT '', -- empty for OIDC-only accounts
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, -- sha256(token), raw token only in the cookie
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);

CREATE TABLE servers (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    protocol   TEXT NOT NULL CHECK (protocol IN ('sftp','ftps','ftp')),
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL,
    username   TEXT NOT NULL,
    secret_enc BLOB NOT NULL, -- AES-GCM encrypted password
    root_path  TEXT NOT NULL DEFAULT '/',
    host_key   TEXT NOT NULL DEFAULT '', -- SSH host key, trust-on-first-use
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE downloads (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    remote_path TEXT NOT NULL,
    local_path  TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    transferred INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','paused','done','error','canceled')),
    error       TEXT NOT NULL DEFAULT '',
    rate_limit  INTEGER NOT NULL DEFAULT 0, -- bytes/s, 0 = unlimited (global limit still applies)
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_downloads_status ON downloads(status);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE anilist_cache (
    key        TEXT PRIMARY KEY, -- e.g. "search:<query>" or "media:<id>"
    payload    TEXT NOT NULL,    -- raw JSON
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE catalog_matches (
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    folder     TEXT NOT NULL, -- remote folder path
    media_id   INTEGER NOT NULL, -- AniList media id, 0 = explicitly unmatched
    manual     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, folder)
);
