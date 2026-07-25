-- Local catalog rows that know nothing about their own quality, and are
-- superseded by better ones.
--
-- Matching a folder in the local catalog calls refreshVariant with server_id 0,
-- and there is no file index there to read a resolution from - so the row lands
-- with res_rank 0 and no languages, usually pointing at the series root rather
-- than a season folder. Comparing a remote copy against such a row always finds
-- an improvement: 1080 beats 0, and any language set is a superset of none.
-- That is how JoJo's Bizarre Adventure was listed as needing an upgrade while
-- sitting complete in Season_01 through Season_06 at 1080p, and why the sync
-- then aimed at the series root - that blind row's folder.
--
-- Only the ones the Plex index has already replaced go: it writes real
-- per-season rows and keeps them current. A blind row that is a show's ONLY
-- trace stays, because "this series exists locally" is what the
-- missing-season suggestions read it for, and there the quality does not
-- matter.
--
-- buildUpgrades ignores blind rows from now on, so this is about the state on
-- disk today, not about preventing new ones.
DELETE FROM catalog_variants
WHERE server_id = 0 AND res_rank = 0 AND length(dub_codes) = 0 AND length(sub_codes) = 0
  AND EXISTS (
    SELECT 1 FROM catalog_variants better
    WHERE better.show_key = catalog_variants.show_key
      AND NOT (better.server_id = 0 AND better.res_rank = 0
               AND length(better.dub_codes) = 0 AND length(better.sub_codes) = 0)
  );
