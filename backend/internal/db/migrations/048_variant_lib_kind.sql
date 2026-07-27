-- Which Plex library a local copy lives in, recorded as the library's KIND:
-- 'anime' when the library holds anime, '' when that was never decided.
--
-- A suggestion is only as well scoped as the row it starts from, and a variant
-- row knew nothing about its library. The library title was recovered after the
-- fact from the folder path (plexLibraryOf, longest matching mount), which
-- fails in exactly the case that matters: a Plex file that is not on a shared
-- mount is stored under the pseudo folder "plex:{ratingKey}:s{N}" and has no
-- path to match. Those rows were unscoped, so an anime series whose disk was
-- not mounted got its cards filed next to the live-action ones.
--
-- The kind is written at index time, straight from the section, so it survives
-- a missing mount. It is POSITIVE evidence only: '' means undecided, never
-- "not anime". Nothing may use it as a veto - a library the user calls "Filme"
-- can still hold anime, and suppressing on '' would delete real suggestions.
-- It fills in the category when the series kind is not decided yet, nothing more.
--
-- Trap, same as the one 027 and 046 record: catalog_variants rows are written
-- with INSERT OR REPLACE (refreshVariant, indexPlexLibrary). Every writer must
-- name this column, or the value falls back to the default on the next sweep.
ALTER TABLE catalog_variants ADD COLUMN lib_kind TEXT NOT NULL DEFAULT '';

-- The rest of this migration is a one-off reset, forced here rather than by a
-- flag in the code, so upgrading to this version cleans up exactly once and a
-- rollback cannot leave the flag set.
--
-- The server-0 rows are the local Plex index, and they were built by a
-- form-blind pipeline: a film and a season could share one canonical unit, so
-- some of these rows carry a show_key/is_movie pairing that the new grouping
-- would keep believing. Drop them and clear the hourly gate; indexPlexLibrary
-- rebuilds every one of them, now with lib_kind. Upgrades and the missing-unit
-- half of "incomplete" are empty between here and the next sweep tick, which is
-- the honest state - stale rows would just keep producing the wrong cards.
-- Only the variants: a server-0 catalog_matches row is not written by the Plex
-- index and may be a manual match the user made, so it stays.
DELETE FROM catalog_variants WHERE server_id = 0;
DELETE FROM settings         WHERE key = 'plex_indexed_at';

-- Plex ratingKeys are not stable, and the identity rows were attached under the
-- old, form-blind probe. One clean pass over every matched folder.
DELETE FROM plex_reconciled;

-- Every cached blob below was built from the old units: the per-user suggestion
-- lists, the missing-sequel list (which gains a kind field), and the three
-- lookup indexes that map Plex titles/guids onto shows.
DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%' OR key LIKE 'plex:%';

-- ClearStaleSuggestionCache skips its work when this stamp already matches the
-- current format. Clearing it means the check runs once more on the next boot
-- whatever the constant says.
DELETE FROM settings WHERE key = 'sugg_fmt';
