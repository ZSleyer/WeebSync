-- Accounts the first OIDC login created were stored unverified although the
-- provider had confirmed the address, so they never got a notification mail.
-- They are the ones without a password.
UPDATE users SET email_verified = 1 WHERE password_hash = '' AND email_verified = 0;
