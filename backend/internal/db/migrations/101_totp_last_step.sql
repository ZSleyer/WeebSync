-- The time step of the last TOTP code that got the account in. A code is
-- valid for three steps, so only "a later step than this" keeps a used code
-- from working a second time (RFC 6238 §5.2); last_code stays unused.
ALTER TABLE user_totp ADD COLUMN last_step INTEGER NOT NULL DEFAULT 0;
