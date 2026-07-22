-- Persisted quality per physical location (server_id + folder, 1:1 with a
-- catalog_matches row). Filled by the match sweep from the remote_index (remote
-- servers) or the local listing (server 0). Deliberately NOT columns on
-- catalog_matches: the matchers INSERT OR REPLACE that row and set only a subset
-- of its columns, so any quality column there would reset on every re-match.
--
-- server_id 0 = local filesystem, which has no servers row and thus no foreign
-- key; the server-delete handler cleans these rows up explicitly (see 025).
CREATE TABLE catalog_variants (
    server_id   INTEGER NOT NULL,           -- 0 = local filesystem
    folder      TEXT    NOT NULL,
    res_rank    INTEGER NOT NULL DEFAULT 0, -- max video height (720/1080/2160); 0 = unknown
    dub_codes   TEXT    NOT NULL DEFAULT '',-- CSV of normalised dub language codes (sorted)
    sub_codes   TEXT    NOT NULL DEFAULT '',-- CSV of normalised sub language codes (sorted)
    computed_at TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (server_id, folder)
);
