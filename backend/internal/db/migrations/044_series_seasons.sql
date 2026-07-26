-- The seasons a show is made of.
--
-- series bundles by the folded title, so every cour of a long-running show
-- became an entry of its own: JoJo ran as five series, Sword Art Online as
-- nine. The rest of the app already groups one level up - folderUnit builds
-- "tvdb:262954" for all of them - because the Fribb mapping carries both
-- halves: which show an AniList work belongs to, and which season it is.
--
-- Merging the cours into one show would throw away their names, and those are
-- the best season titles we have: TVDB and TMDB mostly answer "Season 3",
-- AniList answers "Stardust Crusaders". This table keeps them, whichever
-- provider named the season.
CREATE TABLE series_seasons (
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    season    INTEGER NOT NULL CHECK (season >= 0),
    title     TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL DEFAULT '',
    year      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (series_id, season)
);
