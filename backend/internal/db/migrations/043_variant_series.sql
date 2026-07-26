-- Which series a physical copy belongs to.
--
-- Until now a copy was grouped by show_key, a string built independently by two
-- code paths: the Plex index from the Plex GUID, the catalog match from the
-- provider hit (for anime through the Fribb mapping). Nothing compared them, so
-- the same show could carry two - "tvdb:262954" from Plex and "tvdb:83950" from
-- Fribb, both real entries - and ran as two shows.
--
-- series.id settles it. Every provider id of a show hangs on one series row, so
-- whichever id a copy resolves through, it arrives at the same place.
--
-- show_key stays for now: a copy whose series cannot be resolved still needs a
-- grouping key, and keeping both makes the switch reversible.
ALTER TABLE catalog_variants ADD COLUMN series_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_catalog_variants_series ON catalog_variants(series_id, season);

-- Fill in what can be resolved right now, so the first sweep after the update
-- does not have to rebuild everything: a variant's folder has a match, the
-- match has a provider hit, and that hit hangs on a series.
UPDATE catalog_variants SET series_id = (
    SELECT sp.series_id FROM catalog_matches cm
    JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
    WHERE cm.server_id = catalog_variants.server_id AND cm.folder = catalog_variants.folder
    LIMIT 1
)
WHERE EXISTS (
    SELECT 1 FROM catalog_matches cm
    JOIN series_provider sp ON sp.source = cm.source AND sp.media_id = cm.media_id
    WHERE cm.server_id = catalog_variants.server_id AND cm.folder = catalog_variants.folder
);
