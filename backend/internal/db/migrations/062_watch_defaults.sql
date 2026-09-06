-- Per-user defaults for a new auto-sync or one-off sync: target folder,
-- subfolder and rename template per media kind, plus the rename provider,
-- language filters and Plex stream picks shared by all kinds. JSON, empty =
-- nothing set (the dialogs start blank as before).
ALTER TABLE users ADD COLUMN watch_defaults TEXT NOT NULL DEFAULT '';
