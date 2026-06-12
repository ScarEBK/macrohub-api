-- Migration: Align PostgreSQL schema with Convex fields (2026-06-12)
-- Run this against the Railway PostgreSQL instance via psql or Railway dashboard SQL console.

-- 1. users: rename avatar → avatar_url, add hwid_reset_count + last_seen_at, add hwid index
ALTER TABLE users RENAME COLUMN avatar TO avatar_url;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hwid_reset_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();
CREATE INDEX IF NOT EXISTS users_hwid_idx ON users(hwid);

-- 2. license_keys: rename discord_id → redeemed_by
ALTER TABLE license_keys RENAME COLUMN discord_id TO redeemed_by;

-- 3. announcements: add dismissible boolean
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS dismissible BOOLEAN DEFAULT FALSE;

-- 4. pending_entitlements: add expires_at
ALTER TABLE pending_entitlements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
