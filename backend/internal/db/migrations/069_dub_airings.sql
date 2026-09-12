-- A dub gets its own release slots. The providers date the original broadcast
-- only; a synchronised version follows weeks later, and someone filtering
-- downloads for that dub waits for its date, not the Japanese one. Recorded
-- dub releases share the airings table, told apart by the language they are
-- in ('' = the original) - the same episode released twice is two rows, so
-- the language joins the key. SQLite cannot change a primary key in place.
CREATE TABLE airings_new (
  source    TEXT    NOT NULL,
  media_id  INTEGER NOT NULL,
  airing_at INTEGER NOT NULL,
  episode   INTEGER NOT NULL,
  lang      TEXT    NOT NULL DEFAULT '', -- '' original, else the dub's short tag (de, en, ...)
  PRIMARY KEY (source, media_id, episode, lang)
) WITHOUT ROWID;
INSERT INTO airings_new (source, media_id, airing_at, episode, lang)
  SELECT source, media_id, airing_at, episode, '' FROM airings;
DROP TABLE airings;
ALTER TABLE airings_new RENAME TO airings;

-- How many days the dub trails the original when nothing has been observed
-- yet, or when the observation is not to be trusted. 0 = learn it from the
-- releases seen, project nothing until one has been.
ALTER TABLE watches ADD COLUMN dub_lag_days INTEGER NOT NULL DEFAULT 0;
