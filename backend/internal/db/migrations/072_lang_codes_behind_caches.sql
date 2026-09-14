-- 071 cleared the catalog rows that carried an invented language code and
-- expected them to come back measured. They came back identical: the two
-- caches a row is rebuilt from hold codes that were already canonical when
-- they were written, so the corrected map never reached them.
--
--   probe_cache.quality    the local ffprobe result, keyed by folder signature
--   anilist_cache          'langprobe:<server>:<path>', the remote probe, 30d
--
-- Deleting the catalog rows alone was therefore a no-op with extra steps: the
-- next sweep read the stale cache and wrote "Enm" back beside the real "Eng".
-- Both caches go here, and canonLangs now re-reads a stored code through the
-- current map on the way out, so the next correction needs no migration at all.
DELETE FROM probe_cache
 WHERE quality LIKE '%"Ang"%' OR quality LIKE '%"Enm"%'
    OR quality LIKE '%"Goh"%' OR quality LIKE '%"Gmh"%'
    OR quality LIKE '%"Fro"%' OR quality LIKE '%"Frm"%';

DELETE FROM anilist_cache
 WHERE key LIKE 'langprobe:%'
   AND (payload LIKE '%"Ang"%' OR payload LIKE '%"Enm"%'
     OR payload LIKE '%"Goh"%' OR payload LIKE '%"Gmh"%'
     OR payload LIKE '%"Fro"%' OR payload LIKE '%"Frm"%');

-- and the rows themselves, now that what rebuilds them is clean
DELETE FROM catalog_variants
 WHERE ',' || dub_codes  || ',' LIKE '%,Ang,%' OR ',' || dub_codes  || ',' LIKE '%,Enm,%'
    OR ',' || dub_codes  || ',' LIKE '%,Goh,%' OR ',' || dub_codes  || ',' LIKE '%,Gmh,%'
    OR ',' || dub_codes  || ',' LIKE '%,Fro,%' OR ',' || dub_codes  || ',' LIKE '%,Frm,%'
    OR ',' || sub_codes  || ',' LIKE '%,Ang,%' OR ',' || sub_codes  || ',' LIKE '%,Enm,%'
    OR ',' || sub_codes  || ',' LIKE '%,Goh,%' OR ',' || sub_codes  || ',' LIKE '%,Gmh,%'
    OR ',' || sub_codes  || ',' LIKE '%,Fro,%' OR ',' || sub_codes  || ',' LIKE '%,Frm,%'
    OR ',' || soft_codes || ',' LIKE '%,Ang,%' OR ',' || soft_codes || ',' LIKE '%,Enm,%'
    OR ',' || soft_codes || ',' LIKE '%,Goh,%' OR ',' || soft_codes || ',' LIKE '%,Gmh,%'
    OR ',' || soft_codes || ',' LIKE '%,Fro,%' OR ',' || soft_codes || ',' LIKE '%,Frm,%';

DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%';
