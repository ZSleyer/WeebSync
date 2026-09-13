-- A one-off sync ("sync once" on an upgrade or an incomplete season) runs the
-- full auto-sync pipeline but persists no watch, so it had nowhere to hang the
-- Plex playback preference the user configured: the audio/subtitle choice was
-- accepted by the endpoint and then silently dropped. The queue now carries the
-- preference itself, and watch_id is optional - NULL means "no watch behind
-- this row", which is exactly a one-off sync.
CREATE TABLE plex_stream_queue_new (
  download_id INTEGER PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
  watch_id INTEGER REFERENCES watches(id) ON DELETE CASCADE,
  plex_audio_lang TEXT NOT NULL DEFAULT '',
  plex_sub_lang TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO plex_stream_queue_new (download_id, watch_id, created_at)
  SELECT download_id, watch_id, created_at FROM plex_stream_queue;
DROP TABLE plex_stream_queue;
ALTER TABLE plex_stream_queue_new RENAME TO plex_stream_queue;
