CREATE TABLE tmdb_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tmdb_account_id INTEGER NOT NULL,
  tmdb_username TEXT NOT NULL DEFAULT '',
  session_enc BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
