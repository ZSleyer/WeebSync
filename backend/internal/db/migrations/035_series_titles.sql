-- All available title translations per bundled series, from every linked
-- provider. locale is a BCP-47 primary subtag ('de', 'en', 'ja'); 'x-jat'
-- carries the romanised (Romaji) title. Filled by the sweep's title job.
CREATE TABLE series_titles (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('anilist', 'tmdb', 'tvdb')),
  locale TEXT NOT NULL CHECK (locale != ''),
  title TEXT NOT NULL CHECK (title != ''),
  PRIMARY KEY (series_id, source, locale)
);

-- fetch stamp: '' = never fetched, so new series are picked up automatically
ALTER TABLE series ADD COLUMN titles_fetched_at TEXT NOT NULL DEFAULT '';
