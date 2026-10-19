-- The address a session was last used from, so the account page can say
-- where a browser is signed in. Stamped together with last_seen; empty until
-- a session from before this column is next stamped.
ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
