-- Per-watch Plex playback preference: after a synced episode lands in Plex,
-- select its audio/subtitle stream ("Ger", "Jap", ...) for the linked account.
-- "" = leave Plex untouched. Distinct from want_dub/want_sub, which gate the
-- download itself.
ALTER TABLE watches ADD COLUMN plex_audio_lang TEXT NOT NULL DEFAULT '';
ALTER TABLE watches ADD COLUMN plex_sub_lang TEXT NOT NULL DEFAULT '';

-- Downloads whose episode still awaits that stream-selection pass: filled when
-- a watch with a preference enqueues files, drained by the sweep once Plex has
-- indexed the file (or after a give-up window).
CREATE TABLE plex_stream_queue (
  download_id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
