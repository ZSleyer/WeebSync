-- Forgotten passwords: a reset link by mail. Only the token's hash is kept,
-- so a copy of the database hands nobody a working link; the link is good for
-- an hour from reset_sent_at and once.
ALTER TABLE users ADD COLUMN reset_token_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN reset_sent_at TEXT NOT NULL DEFAULT '';
