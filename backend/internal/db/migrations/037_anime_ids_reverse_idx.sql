-- Reverse lookups on the Fribb cross-provider map (tvdb/tmdb -> anilist), used
-- by the local id-match shortcut. Without these the reverse query is a full
-- scan; anime_ids holds the whole dataset.
CREATE INDEX IF NOT EXISTS idx_anime_ids_tvdb ON anime_ids(tvdb_id);
CREATE INDEX IF NOT EXISTS idx_anime_ids_tmdb ON anime_ids(tmdb_id);
