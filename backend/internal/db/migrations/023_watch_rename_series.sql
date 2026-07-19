-- Explicit provider series id for rename resolution, chosen by the user when
-- the automatic match is ambiguous. 0 = auto (Plex guid / confident search).
ALTER TABLE watches ADD COLUMN rename_series_id INTEGER NOT NULL DEFAULT 0;
