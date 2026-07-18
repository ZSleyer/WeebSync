-- Per-watch dub/sub language filter: sync only files whose name/folder carries
-- the wanted language tag ([GerDub], [GerEngSub], ...). "" = no preference, so
-- an episode is grabbed only once it appears in the desired dub/sub language.
ALTER TABLE watches ADD COLUMN want_dub TEXT NOT NULL DEFAULT '';
ALTER TABLE watches ADD COLUMN want_sub TEXT NOT NULL DEFAULT '';
