-- Where a pairing came from, so one source cannot fill the table: source is
-- the rate limiter's key (the address, an IPv6 /64), source_wide the IPv6 /48
-- around it (the address again for IPv4). Empty for rows from before.
ALTER TABLE device_pairings ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE device_pairings ADD COLUMN source_wide TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_device_pairings_source ON device_pairings(source, status);
CREATE INDEX idx_device_pairings_source_wide ON device_pairings(source_wide, status);

-- The identity provider's subject of the session that approved a device
-- (sessions.oidc_sub), on the pairing until its token is issued and then on
-- the token: a back-channel logout of that subject revokes the device even
-- when no browser session of it is left. Empty for a password session.
ALTER TABLE device_pairings ADD COLUMN oidc_sub TEXT NOT NULL DEFAULT '';
ALTER TABLE device_tokens ADD COLUMN oidc_sub TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_device_pairings_oidc_sub ON device_pairings(oidc_sub) WHERE oidc_sub != '';
CREATE INDEX idx_device_tokens_oidc_sub ON device_tokens(oidc_sub) WHERE oidc_sub != '';
