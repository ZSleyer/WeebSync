-- The Plex bridge could not reach a series that already had any tvdb id.
--
-- reconcilePlex selected folders whose series had NO tvdb provider at all, so a
-- series that got one from Fribb was never looked at again. Fribb maps the 2012
-- JoJo season onto tvdb 83950; Plex calls the same show 262954. Both are real
-- entries, and the two never met - which is why the show appeared twice, once
-- per season from the Plex index and once on the series root from the match.
--
-- The selection is now "every matched folder we have not looked at yet", which
-- needs a place to remember that. Attaching an id a series already has is a
-- no-op thanks to INSERT OR IGNORE, so a re-run costs nothing but the lookup.
CREATE TABLE plex_reconciled (
    folder     TEXT NOT NULL PRIMARY KEY,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Start over: every folder gets one pass under the new rule.
DELETE FROM plex_reconciled;

-- imdb was written but never stored: migration 036 restricted source to
-- anilist/tmdb:tv/tmdb:movie/tvdb, and the INSERT error was never checked - so
-- the counter went up while nothing landed, and the imdb branches in folderUnit
-- and providerBadgesLinks were dead code. SQLite cannot ALTER a CHECK, so the
-- table is rebuilt (child table only - dropping a parent cascades with
-- foreign_keys=ON, see migration 036).
CREATE TABLE series_provider_new (
    source    TEXT    NOT NULL CHECK (source IN ('anilist', 'tmdb:tv', 'tmdb:movie', 'tvdb', 'imdb', 'plex')),
    media_id  INTEGER NOT NULL CHECK (media_id > 0),
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    PRIMARY KEY (source, media_id)
);
INSERT INTO series_provider_new (source, media_id, series_id)
    SELECT source, media_id, series_id FROM series_provider;
DROP TABLE series_provider;
ALTER TABLE series_provider_new RENAME TO series_provider;
CREATE INDEX idx_series_provider_series ON series_provider(series_id);
