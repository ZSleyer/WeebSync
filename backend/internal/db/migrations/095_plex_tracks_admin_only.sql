-- Plex track choices act on the admin's Plex account, so only an admin's
-- watches may carry them now; ones a non-admin set before are dropped, or
-- the sweep would keep applying them.
UPDATE watches SET plex_audio_lang = '', plex_sub_lang = ''
	WHERE user_id IN (SELECT id FROM users WHERE is_admin = 0);
-- queued track jobs of their downloads, and Plex tracks in their stored
-- watch defaults (a JSON object with a "common" part), go as well
DELETE FROM plex_stream_queue WHERE watch_id IN
	(SELECT w.id FROM watches w JOIN users u ON u.id = w.user_id WHERE u.is_admin = 0);
UPDATE users SET watch_defaults = json_remove(watch_defaults, '$.common.plexAudioLang', '$.common.plexSubLang')
	WHERE is_admin = 0 AND watch_defaults != '' AND json_valid(watch_defaults);
