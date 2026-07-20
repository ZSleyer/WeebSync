-- The catalog now covers the local filesystem too, addressed as source id 0.
-- That id has no row in `servers`, so the foreign keys have to go; deleting a
-- server cleans up its catalog rows in the delete handler instead. Data is
-- carried over unchanged - these are real user decisions (manual matches,
-- scope marks), not a cache.
CREATE TABLE catalog_matches_new (
    server_id INTEGER NOT NULL, -- 0 = local filesystem
    folder    TEXT    NOT NULL,
    media_id  INTEGER NOT NULL, -- provider media id, 0 = explicitly unmatched
    manual    INTEGER NOT NULL DEFAULT 0,
    source    TEXT    NOT NULL DEFAULT 'anilist',
    PRIMARY KEY (server_id, folder)
);
INSERT INTO catalog_matches_new (server_id, folder, media_id, manual, source)
SELECT server_id, folder, media_id, manual, source FROM catalog_matches;
DROP TABLE catalog_matches;
ALTER TABLE catalog_matches_new RENAME TO catalog_matches;

CREATE TABLE catalog_scopes_new (
    server_id INTEGER NOT NULL, -- 0 = local filesystem
    path      TEXT    NOT NULL,
    kind      TEXT    NOT NULL, -- 'anime' | 'tv' | 'movie' | 'tvdb'
    PRIMARY KEY (server_id, path)
);
INSERT INTO catalog_scopes_new (server_id, path, kind)
SELECT server_id, path, kind FROM catalog_scopes;
DROP TABLE catalog_scopes;
ALTER TABLE catalog_scopes_new RENAME TO catalog_scopes;
