-- Plex track choices act on the admin's Plex account, so only an admin's
-- watches may carry them now; ones a non-admin set before are dropped, or
-- the sweep would keep applying them.
UPDATE watches SET plex_audio_lang = '', plex_sub_lang = ''
	WHERE user_id IN (SELECT id FROM users WHERE is_admin = 0);
