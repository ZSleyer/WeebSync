-- Linked AniList accounts (OAuth): one per weebsync user. The access token
-- is AES-GCM encrypted like server passwords; AniList tokens live ~1 year
-- and there is no refresh token, so expires_at drives a re-connect hint.
CREATE TABLE anilist_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  anilist_user_id INTEGER NOT NULL,
  anilist_name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  token_enc BLOB NOT NULL,
  expires_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
