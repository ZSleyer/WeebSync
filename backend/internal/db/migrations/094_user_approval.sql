-- An account that signed itself up (registration, or a first sign-in through
-- the identity provider) waits for an admin to let it in, open registration
-- or not. Accounts from before, and accounts an admin creates, are approved.
ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
