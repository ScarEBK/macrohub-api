import postgres from 'postgres';

const MIGRATIONS = [
  // 1. users: rename avatar → avatar_url, add hwid_reset_count + last_seen_at, add hwid index
  { name: 'rename users.avatar → avatar_url',
    sql: `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'avatar_url')
      THEN
        ALTER TABLE users RENAME COLUMN avatar TO avatar_url;
      END IF;
    END $$;`,
  },
  { name: 'add users.hwid_reset_count',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS hwid_reset_count INTEGER DEFAULT 0;`,
  },
  { name: 'add users.last_seen_at',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();`,
  },
  { name: 'add users_hwid_idx',
    sql: `CREATE INDEX IF NOT EXISTS users_hwid_idx ON users(hwid);`,
  },

  // 2. license_keys: rename discord_id → redeemed_by
  { name: 'rename license_keys.discord_id → redeemed_by',
    sql: `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'license_keys' AND column_name = 'discord_id')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'license_keys' AND column_name = 'redeemed_by')
      THEN
        ALTER TABLE license_keys RENAME COLUMN discord_id TO redeemed_by;
      END IF;
    END $$;`,
  },

  // 3. announcements: add dismissible
  { name: 'add announcements.dismissible',
    sql: `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS dismissible BOOLEAN DEFAULT FALSE;`,
  },

  // 4. pending_entitlements: add expires_at
  { name: 'add pending_entitlements.expires_at',
    sql: `ALTER TABLE pending_entitlements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;`,
  },

  // 5. trial_registrations: add new columns matching Convex
  { name: 'add trial_registrations.discord_username',
    sql: `ALTER TABLE trial_registrations ADD COLUMN IF NOT EXISTS discord_username VARCHAR(255);`,
  },
  { name: 'add trial_registrations.email',
    sql: `ALTER TABLE trial_registrations ADD COLUMN IF NOT EXISTS email VARCHAR(500);`,
  },
  { name: 'add trial_registrations.interest_reason',
    sql: `ALTER TABLE trial_registrations ADD COLUMN IF NOT EXISTS interest_reason TEXT;`,
  },
  { name: 'add trial_registrations.started_at',
    sql: `ALTER TABLE trial_registrations ADD COLUMN IF NOT EXISTS started_at TIMESTAMP DEFAULT NOW();`,
  },
  { name: 'add trial_registrations.expires_at',
    sql: `ALTER TABLE trial_registrations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;`,
  },

  // 6. client_reports: add new columns matching Convex
  { name: 'add client_reports.discord_username',
    sql: `ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS discord_username VARCHAR(255);`,
  },
  { name: 'add client_reports.app_version',
    sql: `ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS app_version VARCHAR(32);`,
  },
  { name: 'add client_reports.hwid_prefix',
    sql: `ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS hwid_prefix VARCHAR(32) DEFAULT 'unknown';`,
  },
  { name: 'add client_reports.severity',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_reports' AND column_name = 'severity')
      THEN
        ALTER TABLE client_reports ADD COLUMN severity VARCHAR(20) NOT NULL DEFAULT 'error';
      END IF;
    END $$;`,
  },
  { name: 'add client_reports.route',
    sql: `ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS route VARCHAR(256);`,
  },
  { name: 'migrate client_reports.type to severity',
    sql: `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_reports' AND column_name = 'type')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_reports' AND column_name = 'severity')
      THEN
        ALTER TABLE client_reports RENAME COLUMN type TO severity;
      END IF;
    END $$;`,
  },
  { name: 'alter client_reports.message not null',
    sql: `DO $$ BEGIN
      -- Make message NOT NULL if it isn't already
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_reports' AND column_name = 'message' AND is_nullable = 'YES')
      THEN
        UPDATE client_reports SET message = '(no message)' WHERE message IS NULL;
        ALTER TABLE client_reports ALTER COLUMN message SET NOT NULL;
      END IF;
    END $$;`,
  },
  { name: 'alter client_reports.context type to text',
    sql: `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'client_reports' AND column_name = 'context' AND data_type = 'jsonb')
      THEN
        -- Migrate jsonb context to text
        ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS context_text TEXT;
        UPDATE client_reports SET context_text = context::text WHERE context IS NOT NULL;
        ALTER TABLE client_reports DROP COLUMN context;
        ALTER TABLE client_reports RENAME COLUMN context_text TO context;
      END IF;
    END $$;`,
  },

  // 7. announcements: add created_by_discord_id
  { name: 'add announcements.created_by_discord_id',
    sql: `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by_discord_id VARCHAR(255);`,
  },
  { name: 'alter announcements.dismissible default to true',
    sql: `ALTER TABLE announcements ALTER COLUMN dismissible SET DEFAULT TRUE;`,
  },
  // 8. license_keys: make sellauth_order_id unique to prevent duplicate
  // fulfillment on concurrent SellAuth webhook retries.
  { name: 'create unique index license_keys_sellauth_order_id_unique',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS license_keys_sellauth_order_id_unique ON license_keys (sellauth_order_id);`,
  },
  // 9. C-1 fix (audit 2026-06-19): account-level ban list on users. JSON array
  // of macro names the user is banned from redeeming. Set by /licenses/ban,
  // cleared by /licenses/unban. Prevents a banned user from circumventing a
  // ban by buying a fresh key for the same macro.
  { name: 'add users.banned_macros',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_macros JSONB DEFAULT '[]'::jsonb;`,
  },
];

export async function runMigrations(dbUrl: string) {
  const client = postgres(dbUrl);
  try {
    for (const mig of MIGRATIONS) {
      try {
        await client.unsafe(mig.sql);
        console.log(`[migrate] ✓ ${mig.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Ignore already-exists / already-renamed errors
        if (/already exists|does not exist|duplicate/i.test(msg)) {
          console.log(`[migrate] ⊘ ${mig.name} — ${msg}`);
        } else {
          console.error(`[migrate] ✗ ${mig.name} — ${msg}`);
          throw err;
        }
      }
    }
    console.log('[migrate] All migrations applied');
  } finally {
    await client.end();
  }
}
