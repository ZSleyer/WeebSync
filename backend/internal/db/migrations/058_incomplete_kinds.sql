-- The cached suggestion blob gained a kind per incomplete item, episode gaps
-- inside owned seasons and a duplicates list, and upgrades are ranked by the
-- user's axis order. A blob written before that has none of it and would be
-- served as is until its TTL ran out; dropping them makes the next request
-- rebuild.
DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%';
