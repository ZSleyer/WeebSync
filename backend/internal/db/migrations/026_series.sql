-- A canonical series bundles every physical location and every provider hit
-- (AniList/TMDB/TVDB) that resolves to the same logical show. Until now a match
-- was a single flat catalog_matches row with exactly one provider per folder;
-- the same show in 720p and 1080p, across servers, or recognised by different
-- APIs was never joined. series + series_provider add that identity layer.
--
-- series is global, like catalog_matches (reuseMatch is user-blind, so the
-- catalog is effectively shared). If real multi-tenancy ever lands, series and
-- the delete-time GC have to become user-scoped.
CREATE TABLE series (
    id    INTEGER PRIMARY KEY,
    key   TEXT    NOT NULL,            -- normalised fold key = canonical identity
    title TEXT    NOT NULL DEFAULT '', -- best display title seen so far
    year  INTEGER NOT NULL DEFAULT 0   -- conservative merge criterion
);
CREATE INDEX idx_series_key ON series(key);

-- Cross-provider identity: every provider media_id belongs to exactly one
-- series. The same (source, media_id) on many servers is automatically the same
-- series; different providers fold together over series.key.
CREATE TABLE series_provider (
    source    TEXT    NOT NULL, -- anilist | tmdb:tv | tmdb:movie | tvdb
    media_id  INTEGER NOT NULL,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    PRIMARY KEY (source, media_id)
);
CREATE INDEX idx_series_provider_series ON series_provider(series_id);

-- Per user: which quality axes count for an upgrade suggestion (CSV, like the
-- locale/email_prefs columns). 'res,sub,dub' = all three by default.
ALTER TABLE users ADD COLUMN upgrade_dims TEXT NOT NULL DEFAULT 'res,sub,dub';
