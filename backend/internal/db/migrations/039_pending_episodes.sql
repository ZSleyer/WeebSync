-- Episodes the metadata provider did not know yet when they were downloaded.
-- Aired mapping turns an absolute number into (season, episode); when the
-- provider has not listed the number yet, renaming it anyway files it under a
-- season the file never belonged to - that is how Detective Conan 1208 became
-- S01E1208 in Season_01. Such a file waits in a collecting folder instead, and
-- the sweep moves it into place once the provider catches up.
CREATE TABLE pending_episodes (
    download_id INTEGER PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
    watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL, -- the absolute number the provider did not know
    local_path  TEXT    NOT NULL, -- where the file waits
    remote_path TEXT    NOT NULL, -- so the next check does not fetch it a second time
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- the check reads by watch (skip list, waiting count), the sweep by nothing in
-- particular - it walks the lot
CREATE INDEX idx_pending_episodes_watch ON pending_episodes(watch_id);
