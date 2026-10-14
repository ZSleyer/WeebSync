-- What WeebSync may change on a user's AniList account, each the user's own
-- decision and off until they turn it on: the list entry (status, progress,
-- score, removal, the watched-episode step) and the forum (replies, likes).
ALTER TABLE users ADD COLUMN anilist_write_list INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN anilist_write_social INTEGER NOT NULL DEFAULT 0;
