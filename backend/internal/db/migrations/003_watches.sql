-- Persistent folder watches: remote dir -> local dir, re-checked on an
-- interval, optionally renaming files via template on download.
CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  local_path TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT '',
  separator TEXT NOT NULL DEFAULT '',
  title_override TEXT NOT NULL DEFAULT '',
  interval_min INTEGER NOT NULL DEFAULT 30,
  last_check TEXT NOT NULL DEFAULT '',
  last_result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, server_id, remote_path, local_path)
);
