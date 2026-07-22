-- The canonical unit a variant belongs to: (show_key, season) for series, or a
-- movie. This is what makes upgrade/incomplete comparisons per (show, season)
-- instead of per whole show: a local (server 0) season variant and a remote one
-- carry the SAME show_key + season, so a plain GROUP BY lines them up.
--
-- show_key = the shared cross-provider show identity (tvdb:<id>, else tmdb:<id>,
-- else imdb:<id>, else a fold:<title> fallback). season = the season number
-- (0 = base/movie). is_movie = 1 for films. Filled by refreshVariant (remote and
-- local matched folders) and indexPlexLibrary (per-season Plex library rows).
ALTER TABLE catalog_variants ADD COLUMN show_key  TEXT    NOT NULL DEFAULT '';
ALTER TABLE catalog_variants ADD COLUMN season    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_variants ADD COLUMN is_movie  INTEGER NOT NULL DEFAULT 0;
