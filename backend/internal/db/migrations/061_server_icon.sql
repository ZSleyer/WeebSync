-- A picture for the source switch on the files page: one of a fixed set of
-- icon names, empty = the server shows its name instead.
ALTER TABLE servers ADD COLUMN icon TEXT NOT NULL DEFAULT '';
