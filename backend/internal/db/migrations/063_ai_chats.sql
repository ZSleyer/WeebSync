-- Saved assistant conversations, one row per chat: the turns as the client
-- renders them (JSON, opaque to the server), a title from the first
-- question, and the time of the last change for the history list.
CREATE TABLE ai_chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  turns      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ai_chats_user ON ai_chats(user_id, updated_at);
