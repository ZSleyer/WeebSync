-- Two indexes over the directories of remote_index only (a tenth of its rows),
-- for the two queries that walked every row of a server instead:
--
-- crawl: the crawler picks the dirs due for a relisting, oldest listed_at
-- first, every few minutes per server. With this it reads the due ones in
-- order instead of the whole server and a sort.
CREATE INDEX idx_remote_index_crawl ON remote_index(server_id, listed_at) WHERE is_dir = 1;

-- dirs: the remote candidates of a suggestion match words anywhere in a dir
-- name. No index serves a LIKE '%word%', but this one carries name and path,
-- so the scan reads the dirs and never touches a file row or the table.
CREATE INDEX idx_remote_index_dirs ON remote_index(server_id, name, path) WHERE is_dir = 1;
