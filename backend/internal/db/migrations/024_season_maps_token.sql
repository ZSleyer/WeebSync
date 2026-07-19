-- Key the aired-order cache by an episode token (TEXT) instead of an integer
-- absolute number, so fractional specials/recaps ("1165.5") can be cached too.
-- This is a cache; dropping it is safe (it rebuilds from the provider). The
-- meta rows are cleared so the map is rebuilt with the new token layout.
DROP TABLE IF EXISTS season_maps;
CREATE TABLE season_maps (
    server_id INTEGER NOT NULL,
    folder    TEXT    NOT NULL,
    token     TEXT    NOT NULL, -- "1187" (regular) or "1165.5" (special)
    season    INTEGER NOT NULL,
    episode   INTEGER NOT NULL,
    PRIMARY KEY (server_id, folder, token)
);
DELETE FROM season_maps_meta;
