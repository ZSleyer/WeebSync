-- Per-watch rename resolution profile, all empty = auto (derived from Plex's
-- per-show ordering/language, else the global default). Drives which provider
-- and episode order resolves aired-order renames and which language the series
-- title is localized to.
ALTER TABLE watches ADD COLUMN rename_provider   TEXT NOT NULL DEFAULT ''; -- tvdb | tmdb | ''
ALTER TABLE watches ADD COLUMN rename_ordering   TEXT NOT NULL DEFAULT ''; -- official | dvd | absolute | aired | ''
ALTER TABLE watches ADD COLUMN rename_title_lang TEXT NOT NULL DEFAULT ''; -- BCP-47 | ''
