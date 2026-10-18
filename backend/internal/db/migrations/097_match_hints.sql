-- A folder no AniList query found can still be a show AniList does not list
-- (western animation, live action). The TVDB or TMDB lookup for it is stored here, in
-- a table of its own: a hint is a suggestion for the user to confirm, so it
-- must never sit in catalog_matches, where everything that counts matches
-- (series bundling, watches, dashboard counts) reads. Confirming writes the
-- ordinary manual match and drops the row.
--
-- state: 'hint'      offered to the user
--        'dismissed' the user declined it; stays so, the sweep never offers it again
--        'none'      looked up, nothing fit; not asked again before checked_at is old
CREATE TABLE match_hints (
  server_id INTEGER NOT NULL CHECK (server_id >= 0),
  folder TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('hint', 'dismissed', 'none')),
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'tmdb:tv', 'tmdb:movie', 'tvdb', 'tvdb:movie')),
  media_id INTEGER NOT NULL DEFAULT 0 CHECK (media_id >= 0),
  title TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, folder)
);
