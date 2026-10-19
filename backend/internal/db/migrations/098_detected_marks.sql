-- Folder marks WeebSync sets itself when the structure speaks for them (a
-- folder of single titles, a new season folder beside marked ones). A mark
-- the user sets or changes has 0 here, so what the user decided is told from
-- what was detected, and detection never writes over a row that exists.
-- Unix milliseconds of the detection; the web UI lists these and shows the
-- ones newer than what the user last looked at.
ALTER TABLE catalog_scopes ADD COLUMN detected_at INTEGER NOT NULL DEFAULT 0;
