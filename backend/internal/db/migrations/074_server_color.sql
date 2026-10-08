-- A server's colour: its files and folders are tinted with it wherever they
-- appear next to another source's (the search across every index). Empty =
-- picked from the server's id.
ALTER TABLE servers ADD COLUMN color TEXT NOT NULL DEFAULT '';
