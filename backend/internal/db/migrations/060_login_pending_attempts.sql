-- A pending login token could absorb any number of wrong second-factor codes
-- until its five-minute TTL ran out; the per-IP limiter was the only brake.
-- Count the failures on the token itself so guessing costs the password again.
ALTER TABLE login_pending ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
