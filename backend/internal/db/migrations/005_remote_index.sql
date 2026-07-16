-- Remote file index for search: filled passively from browse listings and
-- by a slow background crawler with a strict request budget. May be
-- incomplete at any time and improves over time.
CREATE TABLE remote_index (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                  -- absolute remote path
  parent TEXT NOT NULL,                -- directory whose listing produced this row
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mod_time TEXT NOT NULL DEFAULT '',
  listed_at TEXT NOT NULL DEFAULT '',  -- directories only: when it was last listed itself
  PRIMARY KEY (server_id, path)
);
CREATE INDEX idx_remote_index_name ON remote_index(server_id, name COLLATE NOCASE);
CREATE INDEX idx_remote_index_parent ON remote_index(server_id, parent);
