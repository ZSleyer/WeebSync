-- Whether the account has signed in before, so the new-device notice skips the
-- very first sign-in (there is no device to compare with). Every account that
-- exists when this runs counts as having signed in: the upgrade must not
-- alert for it.
ALTER TABLE users ADD COLUMN signed_in_before INTEGER NOT NULL DEFAULT 0;
UPDATE users SET signed_in_before = 1;
