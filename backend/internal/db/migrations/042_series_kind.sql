-- What kind of thing a series is, decided once instead of guessed per request.
--
-- categorize() read the provider badges: an anilist OR tvdb source meant anime.
-- That held only as long as a tvdb id could reach a series just one way, over
-- the Fribb anime mapping. Now that the Plex bridge attaches the tvdb id of
-- every show it recognises, the same rule would file live action under anime.
--
-- '' means undecided; the sweep fills it in and categorize falls back to the
-- old guess until then.
ALTER TABLE series ADD COLUMN kind TEXT NOT NULL DEFAULT ''; -- anime | live_action | ''
