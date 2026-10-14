-- A correct password the policy now refuses holds the account only once the
-- whole sign-in succeeded: someone who knows the old password but fails the
-- second factor must not put the owner's sessions on hold.
ALTER TABLE login_pending ADD COLUMN weak INTEGER NOT NULL DEFAULT 0;
