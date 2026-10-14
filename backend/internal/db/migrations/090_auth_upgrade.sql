-- A sign-in that worked but no longer meets the rules: a password the policy
-- now refuses ('password'), or a passkey that verified nobody ('passkey').
-- The account is let in and held at a page that asks for the replacement;
-- every other route answers 403 until it is done.
ALTER TABLE users ADD COLUMN auth_upgrade TEXT NOT NULL DEFAULT '';
