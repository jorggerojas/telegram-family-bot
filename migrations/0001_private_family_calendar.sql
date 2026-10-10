CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS google_credentials (
  account TEXT PRIMARY KEY CHECK (account = 'family'),
  encrypted_refresh_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS conversations (
  user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  draft TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'uncertain', 'done')),
  event_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  completed_at INTEGER,
  lease_until INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS pending_actions_owner_status ON pending_actions(owner_id, status, expires_at);
