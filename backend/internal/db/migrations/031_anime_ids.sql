-- External anime-lists mapping (Fribb anime-list-full.json): the reliable bridge
-- from an AniList id (per-season) to the cross-provider ids a Plex library and a
-- remote catalog share (TVDB/TMDB/IMDB) AND the exact season number that AniList
-- id represents on TVDB/TMDB. AniList numbers seasons as separate ids; TVDB/TMDB
-- and Plex use one id with a season index - this table is what lets us line them
-- up per (show, season) instead of guessing from titles.
--
-- Refreshed daily from the upstream dataset (see anime_ids.go). anilist_id is the
-- primary key; a 0 in any id/season column means "not provided by the dataset".
CREATE TABLE anime_ids (
    anilist_id  INTEGER PRIMARY KEY,
    tvdb_id     INTEGER NOT NULL DEFAULT 0,
    tvdb_season INTEGER NOT NULL DEFAULT 0,
    tmdb_id     INTEGER NOT NULL DEFAULT 0,
    tmdb_kind   TEXT    NOT NULL DEFAULT '', -- tv | movie
    tmdb_season INTEGER NOT NULL DEFAULT 0,
    imdb_id     TEXT    NOT NULL DEFAULT ''  -- ttNNNNNNN
);
