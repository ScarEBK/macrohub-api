import postgres from 'postgres';

/**
 * Bootstrap PostgreSQL tables on first deploy (idempotent).
 * Column-level tweaks run afterward in migrate.ts.
 */
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  hwid TEXT,
  hwid_reset_allowed BOOLEAN DEFAULT FALSE,
  hwid_reset_count INTEGER DEFAULT 0,
  referred_by_discord_id VARCHAR(255),
  banned_macros JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_unique ON users(discord_id);
CREATE INDEX IF NOT EXISTS users_hwid_idx ON users(hwid);

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  code VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_code_unique ON referral_codes(code);
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_discord_id_unique ON referral_codes(discord_id);

CREATE TABLE IF NOT EXISTS referral_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_discord_id VARCHAR(255) NOT NULL,
  referred_discord_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  order_id VARCHAR(255),
  macro_name VARCHAR(100),
  duration VARCHAR(20),
  days_awarded INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS referral_events_referrer_idx ON referral_events(referrer_discord_id);
CREATE INDEX IF NOT EXISTS referral_events_referred_idx ON referral_events(referred_discord_id);
CREATE UNIQUE INDEX IF NOT EXISTS referral_events_order_id_unique ON referral_events(order_id);

CREATE TABLE IF NOT EXISTS license_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  macro VARCHAR(100) NOT NULL,
  duration VARCHAR(20) NOT NULL,
  redeemed_by VARCHAR(255),
  sellauth_order_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  redeemed_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS license_keys_key_unique ON license_keys(key);
CREATE INDEX IF NOT EXISTS license_keys_status_idx ON license_keys(status);
CREATE INDEX IF NOT EXISTS license_keys_sellauth_order_id_idx ON license_keys(sellauth_order_id);

CREATE TABLE IF NOT EXISTS user_macros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  macro VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  source VARCHAR(20) NOT NULL,
  duration VARCHAR(20),
  expires_at TIMESTAMP,
  license_key_id UUID REFERENCES license_keys(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_macros_discord_id_idx ON user_macros(discord_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_macros_discord_id_macro_unique ON user_macros(discord_id, macro);
CREATE INDEX IF NOT EXISTS user_macros_discord_id_status_idx ON user_macros(discord_id, status);

CREATE TABLE IF NOT EXISTS pending_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  macro VARCHAR(100) NOT NULL,
  duration VARCHAR(20) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'sellauth',
  order_id VARCHAR(255),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_entitlements_discord_id_idx ON pending_entitlements(discord_id);
CREATE INDEX IF NOT EXISTS pending_entitlements_order_id_idx ON pending_entitlements(order_id);

CREATE TABLE IF NOT EXISTS trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  macro VARCHAR(100) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS trials_discord_id_macro_unique ON trials(discord_id, macro);

CREATE TABLE IF NOT EXISTS trial_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  discord_username VARCHAR(255),
  email VARCHAR(500),
  interest_reason TEXT,
  hwid TEXT NOT NULL,
  macro VARCHAR(100) NOT NULL,
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS trial_registrations_hwid_unique ON trial_registrations(hwid);
CREATE INDEX IF NOT EXISTS trial_registrations_discord_id_idx ON trial_registrations(discord_id);

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id VARCHAR(50) NOT NULL,
  type VARCHAR(20) NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  dismissible BOOLEAN DEFAULT TRUE,
  created_by_discord_id VARCHAR(255),
  starts_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS announcements_app_id_idx ON announcements(app_id);
CREATE INDEX IF NOT EXISTS announcements_app_id_starts_at_idx ON announcements(app_id, starts_at);

CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  actor_discord_id VARCHAR(255),
  target_discord_id VARCHAR(255),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_logs_created_at_idx ON admin_logs(created_at);

CREATE TABLE IF NOT EXISTS desktop_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255) NOT NULL,
  token VARCHAR(255) NOT NULL,
  hwid TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_sessions_token_unique ON desktop_sessions(token);
CREATE INDEX IF NOT EXISTS desktop_sessions_discord_id_idx ON desktop_sessions(discord_id);

CREATE TABLE IF NOT EXISTS client_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255),
  discord_username VARCHAR(255),
  app_version VARCHAR(32),
  hwid_prefix VARCHAR(32),
  severity VARCHAR(20) NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  route VARCHAR(256),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_reports_created_at_idx ON client_reports(created_at);
CREATE INDEX IF NOT EXISTS client_reports_discord_id_idx ON client_reports(discord_id);

CREATE TABLE IF NOT EXISTS migration_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id VARCHAR(255),
  sellauth_username VARCHAR(255),
  order_id VARCHAR(255),
  macro VARCHAR(100) NOT NULL,
  duration VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS migration_claims_status_idx ON migration_claims(status);
CREATE INDEX IF NOT EXISTS migration_claims_order_id_idx ON migration_claims(order_id);
`;

export async function ensureSchema(dbUrl: string): Promise<void> {
  const client = postgres(dbUrl);
  try {
    await client.unsafe(INIT_SQL);
    console.log('[schema] Tables ensured');
  } finally {
    await client.end();
  }
}
