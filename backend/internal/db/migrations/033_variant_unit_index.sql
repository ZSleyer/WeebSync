-- Indexes for the per-(show, season) suggestion path.
--
-- buildUpgrades/addMissingUnits group catalog_variants by (show_key, season);
-- without this index that is a full table scan on every suggestion rebuild.
CREATE INDEX idx_catalog_variants_unit ON catalog_variants(show_key, season);

-- unitEnrichIndex (SELECT DISTINCT source, media_id) and the relinkOrphans /
-- folderUnit lookups scan catalog_matches by its provider hit.
CREATE INDEX idx_catalog_matches_media ON catalog_matches(source, media_id);
