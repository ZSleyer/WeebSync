-- Opaque handles for the folders the assistant may act on. The model never
-- sees a server id, a remote path or a local mount: every folder it gets from
-- a tool travels as a ref, and propose resolves the ref back here. One row
-- per (user, server, path), keyed by a hash of the three, so the same folder
-- keeps its ref across turns and restarts.
CREATE TABLE ai_refs (
    ref        TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id  INTEGER NOT NULL,
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
