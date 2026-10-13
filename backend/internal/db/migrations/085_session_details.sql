-- When a session began and from which browser, so the account page can list
-- the signed-in devices and end the ones the user does not recognize. Empty
-- for sessions that began before this column existed.
ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
