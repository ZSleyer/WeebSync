-- The browser session a push subscription was made in (the hash of its
-- cookie token, like sessions.token_hash). Logging out or ending that session
-- takes the subscription with it, so notifications stop reaching a browser the
-- account has left. Empty for a subscription from before the column: those
-- stay until the push service reports them gone.
ALTER TABLE push_subscriptions ADD COLUMN session_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_push_session ON push_subscriptions(session_hash) WHERE session_hash != '';
-- However a session ends (logout, the session list, a password change, idle or
-- expiry sweep, OIDC back-channel logout), its subscription goes with it.
CREATE TRIGGER sessions_drop_push AFTER DELETE ON sessions
BEGIN
    DELETE FROM push_subscriptions WHERE session_hash = OLD.token_hash;
END;
