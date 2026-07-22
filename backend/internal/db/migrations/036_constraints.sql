-- Retrofit FOREIGN KEYs and CHECK constraints. SQLite cannot ADD CONSTRAINT,
-- so each table is rebuilt (create _new, copy, drop, rename). Only CHILD
-- tables are rebuilt - dropping a parent with foreign_keys=ON would cascade
-- into its children. Data is normalised first so the copies never violate the
-- new constraints.

-- 1) normalise / clean up
UPDATE watches SET mode = 'template' WHERE mode NOT IN ('template', 'regex');
UPDATE watches SET subfolder = 0 WHERE subfolder NOT IN (0, 1);
UPDATE watches SET aired_mapping = 0 WHERE aired_mapping NOT IN (0, 1);
UPDATE watches SET from_episode = 0 WHERE from_episode < 0;
UPDATE watches SET rename_series_id = 0 WHERE rename_series_id < 0;
UPDATE catalog_matches SET manual = 1 WHERE manual NOT IN (0, 1);
UPDATE catalog_matches SET source = 'anilist' WHERE source NOT IN ('anilist', 'tmdb:tv', 'tmdb:movie', 'tvdb');
DELETE FROM catalog_matches WHERE server_id < 0 OR media_id < 0;
UPDATE catalog_variants SET res_rank = 0 WHERE res_rank < 0;
UPDATE catalog_variants SET season = 0 WHERE season < 0;
UPDATE catalog_variants SET is_movie = 0 WHERE is_movie NOT IN (0, 1);
DELETE FROM catalog_variants WHERE server_id < 0;
DELETE FROM catalog_scopes WHERE server_id < 0;
DELETE FROM season_maps WHERE server_id < 0;
DELETE FROM season_maps_meta WHERE server_id < 0;
DELETE FROM suggestion_dismissals WHERE kind NOT IN ('suggestion', 'upgrade');
UPDATE anime_ids SET tmdb_kind = '' WHERE tmdb_kind NOT IN ('', 'tv', 'movie');
DELETE FROM series_provider WHERE media_id <= 0 OR source NOT IN ('anilist', 'tmdb:tv', 'tmdb:movie', 'tvdb');
DELETE FROM plex_stream_queue WHERE download_id NOT IN (SELECT id FROM downloads)
  OR watch_id NOT IN (SELECT id FROM watches);

-- 2) watches: enum + range checks (before plex_stream_queue gains its FK)
CREATE TABLE watches_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  remote_path TEXT NOT NULL,
  local_path TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT '',
  separator TEXT NOT NULL DEFAULT '',
  title_override TEXT NOT NULL DEFAULT '',
  last_check TEXT NOT NULL DEFAULT '',
  last_result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  mode TEXT NOT NULL DEFAULT 'template' CHECK (mode IN ('template', 'regex')),
  pattern TEXT NOT NULL DEFAULT '',
  replacement TEXT NOT NULL DEFAULT '',
  last_uploading INTEGER NOT NULL DEFAULT 0,
  last_queued INTEGER NOT NULL DEFAULT -1,
  subfolder INTEGER NOT NULL DEFAULT 0 CHECK (subfolder IN (0, 1)),
  from_episode INTEGER NOT NULL DEFAULT 0 CHECK (from_episode >= 0),
  want_dub TEXT NOT NULL DEFAULT '',
  want_sub TEXT NOT NULL DEFAULT '',
  last_filtered INTEGER NOT NULL DEFAULT 0,
  aired_mapping INTEGER NOT NULL DEFAULT 0 CHECK (aired_mapping IN (0, 1)),
  rename_provider TEXT NOT NULL DEFAULT '',
  rename_ordering TEXT NOT NULL DEFAULT '',
  rename_title_lang TEXT NOT NULL DEFAULT '',
  rename_series_id INTEGER NOT NULL DEFAULT 0 CHECK (rename_series_id >= 0),
  plex_audio_lang TEXT NOT NULL DEFAULT '',
  plex_sub_lang TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, server_id, remote_path, local_path)
);
INSERT INTO watches_new SELECT id, user_id, server_id, remote_path, local_path, template, separator, title_override, last_check, last_result, created_at, mode, pattern, replacement, last_uploading, last_queued, subfolder, from_episode, want_dub, want_sub, last_filtered, aired_mapping, rename_provider, rename_ordering, rename_title_lang, rename_series_id, plex_audio_lang, plex_sub_lang FROM watches;
DROP TABLE watches;
ALTER TABLE watches_new RENAME TO watches;

-- 3) plex_stream_queue: lifecycle-coupled FKs
CREATE TABLE plex_stream_queue_new (
  download_id INTEGER PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO plex_stream_queue_new SELECT download_id, watch_id, created_at FROM plex_stream_queue;
DROP TABLE plex_stream_queue;
ALTER TABLE plex_stream_queue_new RENAME TO plex_stream_queue;

-- 4) catalog_matches
CREATE TABLE catalog_matches_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0), -- 0 = local filesystem
  folder TEXT NOT NULL,
  media_id INTEGER NOT NULL CHECK (media_id >= 0), -- 0 = explicitly unmatched
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'anilist' CHECK (source IN ('anilist', 'tmdb:tv', 'tmdb:movie', 'tvdb')),
  PRIMARY KEY (server_id, folder)
);
INSERT INTO catalog_matches_new SELECT server_id, folder, media_id, manual, source FROM catalog_matches;
DROP TABLE catalog_matches;
ALTER TABLE catalog_matches_new RENAME TO catalog_matches;
CREATE INDEX idx_catalog_matches_media ON catalog_matches(source, media_id);

-- 5) catalog_variants
CREATE TABLE catalog_variants_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0), -- 0 = local filesystem
  folder TEXT NOT NULL,
  res_rank INTEGER NOT NULL DEFAULT 0 CHECK (res_rank >= 0),
  dub_codes TEXT NOT NULL DEFAULT '',
  sub_codes TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL DEFAULT '',
  show_key TEXT NOT NULL DEFAULT '',
  season INTEGER NOT NULL DEFAULT 0 CHECK (season >= 0),
  is_movie INTEGER NOT NULL DEFAULT 0 CHECK (is_movie IN (0, 1)),
  PRIMARY KEY (server_id, folder)
);
INSERT INTO catalog_variants_new SELECT server_id, folder, res_rank, dub_codes, sub_codes, computed_at, show_key, season, is_movie FROM catalog_variants;
DROP TABLE catalog_variants;
ALTER TABLE catalog_variants_new RENAME TO catalog_variants;
CREATE INDEX idx_catalog_variants_unit ON catalog_variants(show_key, season);

-- 6) catalog_scopes / season_maps / season_maps_meta: server_id sanity
CREATE TABLE catalog_scopes_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0), -- 0 = local filesystem
  path TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'anime' | 'tv' | 'movie' | 'tvdb'
  PRIMARY KEY (server_id, path)
);
INSERT INTO catalog_scopes_new SELECT server_id, path, kind FROM catalog_scopes;
DROP TABLE catalog_scopes;
ALTER TABLE catalog_scopes_new RENAME TO catalog_scopes;

CREATE TABLE season_maps_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0),
  folder TEXT NOT NULL,
  token TEXT NOT NULL, -- "1187" (regular) or "1165.5" (special)
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  PRIMARY KEY (server_id, folder, token)
);
INSERT INTO season_maps_new SELECT server_id, folder, token, season, episode FROM season_maps;
DROP TABLE season_maps;
ALTER TABLE season_maps_new RENAME TO season_maps;

CREATE TABLE season_maps_meta_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0),
  folder TEXT NOT NULL,
  source TEXT NOT NULL, -- tvdb | plex | tmdb | none
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, folder)
);
INSERT INTO season_maps_meta_new SELECT server_id, folder, source, updated_at FROM season_maps_meta;
DROP TABLE season_maps_meta;
ALTER TABLE season_maps_meta_new RENAME TO season_maps_meta;

-- 7) suggestion_dismissals
CREATE TABLE suggestion_dismissals_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('suggestion', 'upgrade')),
  ref_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  dismissed_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, kind, ref_key)
);
INSERT INTO suggestion_dismissals_new SELECT user_id, kind, ref_key, label, dismissed_at FROM suggestion_dismissals;
DROP TABLE suggestion_dismissals;
ALTER TABLE suggestion_dismissals_new RENAME TO suggestion_dismissals;

-- 8) anime_ids
CREATE TABLE anime_ids_new (
  anilist_id INTEGER PRIMARY KEY,
  tvdb_id INTEGER NOT NULL DEFAULT 0 CHECK (tvdb_id >= 0),
  tvdb_season INTEGER NOT NULL DEFAULT 0,
  tmdb_id INTEGER NOT NULL DEFAULT 0 CHECK (tmdb_id >= 0),
  tmdb_kind TEXT NOT NULL DEFAULT '' CHECK (tmdb_kind IN ('', 'tv', 'movie')),
  tmdb_season INTEGER NOT NULL DEFAULT 0,
  imdb_id TEXT NOT NULL DEFAULT ''
);
INSERT INTO anime_ids_new SELECT anilist_id, tvdb_id, tvdb_season, tmdb_id, tmdb_kind, tmdb_season, imdb_id FROM anime_ids;
DROP TABLE anime_ids;
ALTER TABLE anime_ids_new RENAME TO anime_ids;

-- 9) series_provider: enum + id sanity (child of series, safe to rebuild)
CREATE TABLE series_provider_new (
  source TEXT NOT NULL CHECK (source IN ('anilist', 'tmdb:tv', 'tmdb:movie', 'tvdb')),
  media_id INTEGER NOT NULL CHECK (media_id > 0),
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  PRIMARY KEY (source, media_id)
);
INSERT INTO series_provider_new SELECT source, media_id, series_id FROM series_provider;
DROP TABLE series_provider;
ALTER TABLE series_provider_new RENAME TO series_provider;
CREATE INDEX idx_series_provider_series ON series_provider(series_id);
