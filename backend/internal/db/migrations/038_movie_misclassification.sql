-- Re-derive the units that folderUnit called films on the strength of a
-- provider's format alone. An AniList MOVIE hit on a folder full of episodes
-- filed the show under "movies" with season 0, where no local season could
-- meet it - which is how a 24-episode series ended up in the Filme group.
-- folderUnit now vetoes that with the folder's own file count; these rows
-- predate the veto and have to be recomputed.

-- Remote: every anilist-sourced film row, both shapes the veto now covers -
-- the Fribb "tmdb movie" mapping and the fold: fallback on AniList's format.
-- A row that really is a film comes back as one; the recompute is cheap and
-- budget-bounded. Blank computed_at is what refreshStaleVariants looks for, so
-- the next sweep picks them up and the suggestion stays visible until then.
UPDATE catalog_variants SET computed_at = ''
WHERE server_id != 0 AND is_movie = 1 AND folder IN (
    SELECT folder FROM catalog_matches
    WHERE catalog_matches.server_id = catalog_variants.server_id AND source = 'anilist'
);

-- Local: server 0 is never stale-swept. Dropping the rows lets
-- indexPlexLibrary rebuild them from the Plex section type, the one signal
-- that knows show from movie for certain - the same move BackfillUnits makes.
DELETE FROM catalog_variants WHERE server_id = 0 AND is_movie = 1;
