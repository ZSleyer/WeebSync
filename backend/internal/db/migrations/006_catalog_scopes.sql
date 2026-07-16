-- Folder scope marks: a folder marked 'tv' or 'movie' switches catalog
-- matching below it from AniList (anime, the default) to TMDB. Marks
-- inherit to every folder underneath.
CREATE TABLE catalog_scopes (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'tv' | 'movie'
  PRIMARY KEY (server_id, path)
);
-- catalog matches remember their metadata source; scope changes make
-- mismatched rows eligible for re-matching.
ALTER TABLE catalog_matches ADD COLUMN source TEXT NOT NULL DEFAULT 'anilist';
