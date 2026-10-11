-- Manga as a metadata source: a folder of volumes is matched against AniList's
-- MANGA catalogue under its own source tag. Plain 'anilist' stays anime, so the
-- anime-only passes (season identity, relations, the anime id mapping, dubs)
-- never see a manga id.
--
-- SQLite cannot widen a CHECK in place: rebuild, same shape as 036.
CREATE TABLE catalog_matches_new (
  server_id INTEGER NOT NULL CHECK (server_id >= 0), -- 0 = local filesystem
  folder TEXT NOT NULL,
  media_id INTEGER NOT NULL CHECK (media_id >= 0), -- 0 = explicitly unmatched
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'anilist' CHECK (source IN ('anilist', 'anilist:manga', 'tmdb:tv', 'tmdb:movie', 'tvdb')),
  PRIMARY KEY (server_id, folder)
);
INSERT INTO catalog_matches_new SELECT server_id, folder, media_id, manual, source FROM catalog_matches;
DROP TABLE catalog_matches;
ALTER TABLE catalog_matches_new RENAME TO catalog_matches;
CREATE INDEX idx_catalog_matches_media ON catalog_matches(source, media_id);
