-- Films on TVDB: a folder marked 'tvdb' that holds a film is matched against
-- TVDB's movies under a source of its own. TVDB numbers movies and series
-- apart, so a movie id under the plain 'tvdb' tag would name a series.
--
-- SQLite cannot widen a CHECK in place: rebuild, same shape as 078 and 041.
-- Both are child tables; no parent is dropped.
CREATE TABLE catalog_matches_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0), -- 0 = local filesystem
  folder TEXT NOT NULL,
  media_id INTEGER NOT NULL CHECK (media_id >= 0), -- 0 = explicitly unmatched
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'anilist' CHECK (source IN ('anilist', 'anilist:manga', 'tmdb:tv', 'tmdb:movie', 'tvdb', 'tvdb:movie')),
  PRIMARY KEY (server_id, folder)
);
INSERT INTO catalog_matches_new SELECT server_id, folder, media_id, manual, source FROM catalog_matches;
DROP TABLE catalog_matches;
ALTER TABLE catalog_matches_new RENAME TO catalog_matches;
CREATE INDEX idx_catalog_matches_media ON catalog_matches(source, media_id);

CREATE TABLE series_provider_new (
    source    TEXT    NOT NULL CHECK (source IN ('anilist', 'tmdb:tv', 'tmdb:movie', 'tvdb', 'tvdb:movie', 'imdb', 'plex')),
    media_id  INTEGER NOT NULL CHECK (media_id > 0),
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    manual    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, media_id)
);
INSERT INTO series_provider_new (source, media_id, series_id, manual)
    SELECT source, media_id, series_id, manual FROM series_provider;
DROP TABLE series_provider;
ALTER TABLE series_provider_new RENAME TO series_provider;
CREATE INDEX idx_series_provider_series ON series_provider(series_id);
