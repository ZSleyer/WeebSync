-- Cached absolute-episode -> (season, episode) mapping per watched series.
-- Rebuilt from the metadata provider at most once per TTL (endless series grow
-- weekly); a meta row records freshness and which source produced the map.
CREATE TABLE season_maps (
    server_id INTEGER NOT NULL,
    folder    TEXT    NOT NULL,
    absolute  INTEGER NOT NULL,
    season    INTEGER NOT NULL,
    episode   INTEGER NOT NULL,
    PRIMARY KEY (server_id, folder, absolute)
);

CREATE TABLE season_maps_meta (
    server_id  INTEGER NOT NULL,
    folder     TEXT    NOT NULL,
    source     TEXT    NOT NULL, -- tvdb | plex | tmdb | none
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (server_id, folder)
);
