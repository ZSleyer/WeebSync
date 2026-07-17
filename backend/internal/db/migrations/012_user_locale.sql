-- per-user locale for server-delivered texts (email, web push); '' = unknown → en
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT '';
-- structured watch result so the frontend can localize; -1 = no structured run yet
ALTER TABLE watches ADD COLUMN last_queued INTEGER NOT NULL DEFAULT -1;
