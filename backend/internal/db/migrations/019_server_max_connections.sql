-- Per-server ceiling on concurrent connections. For SFTP the pool multiplexes
-- channels over up to this many connections (one usually suffices); for
-- FTP/FTPS it caps concurrent connections. Default 3 matches a common server
-- limit; the index crawler yields a slot to downloads.
ALTER TABLE servers ADD COLUMN max_connections INTEGER NOT NULL DEFAULT 3;
