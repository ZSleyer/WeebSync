-- The restore list of hidden suggestions shows the item's cover and the list
-- it was hidden from (empty for rows hidden before). The kind check gains
-- 'duplicate': hiding a duplicate was refused by the constraint from 036.
CREATE TABLE suggestion_dismissals_new (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('suggestion', 'upgrade', 'duplicate')),
  ref_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  dismissed_at TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, kind, ref_key)
);
INSERT INTO suggestion_dismissals_new (user_id, kind, ref_key, label, dismissed_at)
  SELECT user_id, kind, ref_key, label, dismissed_at FROM suggestion_dismissals;
DROP TABLE suggestion_dismissals;
ALTER TABLE suggestion_dismissals_new RENAME TO suggestion_dismissals;
