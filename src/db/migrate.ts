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
