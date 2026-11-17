-- Wither Spotify Widget: one-time Cloudflare D1 schema.
-- The Worker encrypts Spotify tokens before writing them to the database.
CREATE TABLE IF NOT EXISTS pending_oauth (
  state_hash TEXT PRIMARY KEY,
  verifier_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS overlays (
  id TEXT PRIMARY KEY,
  view_hash TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  token_cipher TEXT NOT NULL,
  cache_json TEXT,
  cache_until INTEGER NOT NULL DEFAULT 0,
  rate_limit_until INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS art_cache (
  id TEXT PRIMARY KEY,
  url TEXT,
  checked_at INTEGER NOT NULL
);

-- One-use, expiring friend invitations. Only token hashes are stored.
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
