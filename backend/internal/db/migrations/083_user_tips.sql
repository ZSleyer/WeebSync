-- One-time hints in the web UI the user has closed. Kept per account, not in
-- the browser, so a hint closed on the desktop stays closed on the phone. The
-- key is a free string the frontend names its hints by ("install-pwa").
CREATE TABLE user_tips (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tip_key      TEXT    NOT NULL,
    dismissed_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, tip_key)
);
