-- Per-user plex.tv account link, for the personal Plex watchlist (the server
-- token in settings is instance-wide and cannot read a user's watchlist). Token
-- is AES-GCM encrypted like every other stored secret. Same shape as
-- anilist_accounts / tmdb_accounts.
CREATE TABLE plex_accounts (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_enc  TEXT    NOT NULL,
    plex_user  TEXT    NOT NULL DEFAULT '', -- display name, for the settings status line
    created_at TEXT    NOT NULL DEFAULT ''
);
