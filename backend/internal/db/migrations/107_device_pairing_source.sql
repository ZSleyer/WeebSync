-- Where a pairing came from, so one source cannot fill the table: source is
-- the rate limiter's key (the address, an IPv6 /64), source_wide the IPv6 /48
-- around it (the address again for IPv4). Empty for rows from before.
ALTER TABLE device_pairings ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE device_pairings ADD COLUMN source_wide TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_device_pairings_source ON device_pairings(source, status);
CREATE INDEX idx_device_pairings_source_wide ON device_pairings(source_wide, status);
