-- The cached suggestion blobs predate the "recommended" bucket, so they would
-- serve a response without it until their 30-minute TTL expires. Drop them and
-- let the next request (or the sweep) rebuild.
DELETE FROM anilist_cache WHERE key LIKE 'suggestions:%';
