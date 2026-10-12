-- A scope rule marks the folders a parent will hold later: new folders whose
-- name has the same shape as the one the rule was made from ("2026-3 Summer"
-- -> "{n}-{n} {season}") take its kind without being marked one by one. The
-- shape comes from the user's own folder, never from a list in the code.
CREATE TABLE catalog_scope_rules (
    id         INTEGER PRIMARY KEY,
    server_id  INTEGER NOT NULL, -- 0 = local filesystem
    parent     TEXT    NOT NULL,
    shape      TEXT    NOT NULL,
    kind       TEXT    NOT NULL, -- 'anime' | 'manga' | 'tv' | 'movie' | 'tvdb'
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (server_id, parent, shape)
);
