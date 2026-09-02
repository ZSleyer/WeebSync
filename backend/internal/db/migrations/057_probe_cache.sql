-- The Plex library was re-probed from scratch every hour.
--
-- indexPlexLibrary walks every season folder of every show and runs ffprobe
-- over three representative episodes to read the real tracks. Nothing
-- remembered the answer, so a library of ~600 seasons meant ~1800 ffprobe
-- processes and ~600 directory walks per hour, forever, over files that never
-- change. On a home server that is a permanently busy core.
--
-- The remote side has cached its probes since it existed ("files are
-- immutable"); this is the same idea for the local one. `sig` describes the
-- folder as the walk saw it - file count, total size, newest mtime - so a new
-- episode, a replaced file or a re-encode invalidates the entry while an
-- untouched folder is answered from here.
CREATE TABLE probe_cache (
    dir       TEXT NOT NULL PRIMARY KEY,
    sig       TEXT NOT NULL,
    quality   TEXT NOT NULL, -- FolderQuality as JSON
    probed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
