-- Which episodes the dub/sub filter held back at the last check, as a CSV
-- of season-encoded episode keys, so the overview can name them instead of
-- only counting them (last_filtered).
ALTER TABLE watches ADD COLUMN last_filtered_eps TEXT NOT NULL DEFAULT '';
