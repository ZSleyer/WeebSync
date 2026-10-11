-- WeebSync as a source for Sonarr/Radarr: a Newznab feed of the remote files
-- and a SABnzbd-compatible download client.
--
-- arr_releases: every remote file the feed has shown, under the guid the app
-- hands back when it grabs one. The guid is the only thing trusted from the
-- app; server and path are looked up here, never taken from a request.
CREATE TABLE arr_releases (
    guid        TEXT    PRIMARY KEY,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    remote_path TEXT    NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    title       TEXT    NOT NULL,
    seen_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- arr_jobs: one grab, as the app tracks it (nzo_id), and the download that
-- carries it out. job_dir is the local folder the file lands in; download_id
-- 0 means the file was already there when the job was added.
CREATE TABLE arr_jobs (
    nzo_id      TEXT    PRIMARY KEY,
    guid        TEXT    NOT NULL,
    download_id INTEGER NOT NULL DEFAULT 0,
    category    TEXT    NOT NULL DEFAULT '',
    title       TEXT    NOT NULL,
    job_dir     TEXT    NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_arr_jobs_download ON arr_jobs(download_id);
