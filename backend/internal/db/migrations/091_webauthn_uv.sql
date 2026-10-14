-- Passkeys must verify the user (PIN, fingerprint, face). uv_required marks a
-- credential registered under that rule, or one that has shown it can; an
-- older one may still answer without, which signs in once more onto the page
-- that asks for a replacement (users.auth_upgrade = 'passkey'), and
-- replace_due marks the credential that did it.
ALTER TABLE webauthn_credentials ADD COLUMN uv_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webauthn_credentials ADD COLUMN replace_due INTEGER NOT NULL DEFAULT 0;
