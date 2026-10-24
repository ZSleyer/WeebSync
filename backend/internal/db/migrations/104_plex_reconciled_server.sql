-- The Plex reconcile marker knew only the folder, while a matched folder is
-- (server_id, folder): two servers with the same path ("/Anime/Frieren" on two
-- seedboxes) shared one marker, and the second server's folder was never
-- looked at. The marker is derived data, so the table starts over and every
-- folder gets one pass under the new key.
DROP TABLE plex_reconciled;
CREATE TABLE plex_reconciled (
    server_id  INTEGER NOT NULL DEFAULT 0,
    folder     TEXT    NOT NULL,
    checked_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, folder)
);
