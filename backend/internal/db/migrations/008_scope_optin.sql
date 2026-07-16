-- Catalog matching becomes opt-in per folder: without a stored scope mark
-- nothing is matched. Existing installations already matched everything
-- against AniList, so keep their behavior by marking each server root that
-- has AniList matches as 'anime'.
INSERT OR IGNORE INTO catalog_scopes (server_id, path, kind)
SELECT DISTINCT cm.server_id, s.root_path, 'anime'
FROM catalog_matches cm
JOIN servers s ON s.id = cm.server_id
WHERE cm.source = 'anilist' AND s.root_path != '';
