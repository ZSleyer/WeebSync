-- The provider's session id (and subject) behind a login, so a back-channel
-- logout can name exactly the sessions that ended. Empty for password logins.
ALTER TABLE sessions ADD COLUMN oidc_sid TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN oidc_sub TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_sessions_oidc_sid ON sessions (oidc_sid) WHERE oidc_sid <> '';
CREATE INDEX idx_sessions_oidc_sub ON sessions (oidc_sub) WHERE oidc_sub <> '';
