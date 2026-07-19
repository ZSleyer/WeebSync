-- Opt-in per watch: resolve aired-order season boundaries for endless series
-- (e.g. Detective Conan) via TVDB/Plex/TMDB instead of a flat episode offset.
ALTER TABLE watches ADD COLUMN aired_mapping INTEGER NOT NULL DEFAULT 0;
