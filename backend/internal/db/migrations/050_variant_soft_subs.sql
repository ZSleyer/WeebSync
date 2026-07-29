-- Which of a copy's subtitle languages are actually SELECTABLE: a subtitle
-- stream in the container, or a subtitle file lying next to the video.
--
-- sub_codes has always answered "which subtitle languages does this copy
-- advertise", and that is not the same question. An anime release named
-- "[GerSub]" whose container carries no subtitle stream and has no .ass beside
-- it has its subtitles burned into the picture: they cannot be turned off, cannot
-- be restyled, and cannot be read by anything but a pair of eyes. Compared on
-- sub_codes alone it is indistinguishable from a copy with a real German track,
-- so the better copy never showed up as an upgrade.
--
-- soft_codes is the subset that can be handed over as a track. A language in
-- sub_codes but not in soft_codes IS the burned-in case, so no separate
-- "hardsub" column is needed - the difference between the two sets says it.
--
-- Sidecar files count on both sides of a comparison and cost nothing to see: a
-- local folder is walked anyway, and a remote listing already names every file.
-- A sidecar nobody labelled records the hole ('Und') instead of a language: it
-- proves the copy is not hardsubbed without claiming which language it offers.
--
-- Trap, same as the one 027, 046 and 048 record: catalog_variants rows are
-- written with INSERT OR REPLACE (refreshVariant, indexPlexLibrary) through the
-- single writer storeVariant. Every writer must name this column, or the value
-- falls back to the default on the next sweep. 036_constraints.sql rebuilds this
-- table with an explicit column list; a future rebuild must carry it too.
ALTER TABLE catalog_variants ADD COLUMN soft_codes TEXT NOT NULL DEFAULT '';

-- The new axis is on by default for everyone who already asked for the subtitle
-- axis: it is the same interest, told apart more finely. users.upgrade_dims is a
-- CSV whose default is 'res,sub,dub' (026_series.sql).
--
-- The COLUMN default stays 'res,sub,dub': changing a default in SQLite means
-- rebuilding the users table, which is a lot of migration for one word. The
-- three places that create an account name upgrade_dims explicitly instead
-- (registration, the admin's user list, the OIDC first login), so a fresh
-- install does not start with the new axis switched off.
UPDATE users SET upgrade_dims = upgrade_dims || ',soft'
 WHERE ',' || upgrade_dims || ',' LIKE '%,sub,%';

-- One-off reset, forced here rather than by a flag in the code, so upgrading
-- cleans up exactly once and a rollback cannot leave the flag set.
--
-- Every existing row was written under the old rule, where an unreadable track
-- was silently dropped and a burned-in subtitle was indistinguishable from a
-- real one. Those rows read as a COMPLETE account of a copy's languages, which
-- is precisely the reading that produces the suggestions this release removes -
-- leaving them in place would keep the wrong cards alive until each row happened
-- to be rewritten.
--
-- The server-0 rows are the local Plex index; dropping them and clearing the
-- hourly gate makes indexPlexLibrary rebuild every one of them on the next sweep
-- tick. Upgrades are empty in between, which is the honest state.
--
-- The remote rows are deliberately NOT dropped: they heal on their own inside
-- variantRecheck (12h), and forcing all of them at once would blow the per-sweep
-- match budget. Only the local variants: a server-0 catalog_matches row may be a
-- manual match the user made, so it stays.
DELETE FROM catalog_variants WHERE server_id = 0;
DELETE FROM settings         WHERE key = 'plex_indexed_at';
