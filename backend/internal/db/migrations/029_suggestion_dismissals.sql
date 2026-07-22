-- Per-user ignore list for suggestions and upgrades. ref_key is a stable
-- identity for the dismissed item: a series id ("series:42") when one exists,
-- else "source:media_id". Suggestion queries filter these out; the user can
-- restore a dismissed item from a submenu.
CREATE TABLE suggestion_dismissals (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL, -- 'suggestion' | 'upgrade'
    ref_key      TEXT    NOT NULL,
    label        TEXT    NOT NULL DEFAULT '', -- display title, for the restore list
    dismissed_at TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, kind, ref_key)
);
