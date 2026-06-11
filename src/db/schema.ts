import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ──────────────────────────────────────────────
// 1. users — Discord user profiles + HWID binding
// ──────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }).notNull(),
    avatar: text("avatar"),
    hwid: text("hwid"),
    hwidResetAllowed: boolean("hwid_reset_allowed").default(false),
    referredByDiscordId: varchar("referred_by_discord_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("users_discord_id_unique").on(table.discordId),
  ],
);

// ──────────────────────────────────────────────
// 2. referralCodes — One referral code per user
// ──────────────────────────────────────────────
export const referralCodes = pgTable(
  "referral_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("referral_codes_code_unique").on(table.code),
    uniqueIndex("referral_codes_discord_id_unique").on(table.discordId),
  ],
);

// ──────────────────────────────────────────────
// 3. referralEvents — Install/purchase referral reward tracking
// ──────────────────────────────────────────────
export const referralEvents = pgTable(
  "referral_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerDiscordId: varchar("referrer_discord_id", { length: 255 }).notNull(),
    referredDiscordId: varchar("referred_discord_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    orderId: varchar("order_id", { length: 255 }),
    macroName: varchar("macro_name", { length: 100 }),
    duration: varchar("duration", { length: 20 }),
    daysAwarded: integer("days_awarded"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("referral_events_referrer_idx").on(table.referrerDiscordId),
    index("referral_events_referred_idx").on(table.referredDiscordId),
    uniqueIndex("referral_events_order_id_unique").on(table.orderId),
  ],
);

// ──────────────────────────────────────────────
// 4. licenseKeys — Generated license keys
// ──────────────────────────────────────────────
export const licenseKeys = pgTable(
  "license_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("available"),
    macro: varchar("macro", { length: 100 }).notNull(),
    duration: varchar("duration", { length: 20 }).notNull(),
    discordId: varchar("discord_id", { length: 255 }),
    sellauthOrderId: varchar("sellauth_order_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow(),
    redeemedAt: timestamp("redeemed_at"),
  },
  (table) => [
    uniqueIndex("license_keys_key_unique").on(table.key),
    index("license_keys_status_idx").on(table.status),
    index("license_keys_sellauth_order_id_idx").on(table.sellauthOrderId),
  ],
);

// ──────────────────────────────────────────────
// 5. userMacros — Per-user macro access records
// ──────────────────────────────────────────────
export const userMacros = pgTable(
  "user_macros",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    macro: varchar("macro", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    source: varchar("source", { length: 20 }).notNull(),
    duration: varchar("duration", { length: 20 }),
    expiresAt: timestamp("expires_at"),
    licenseKeyId: uuid("license_key_id").references(() => licenseKeys.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("user_macros_discord_id_idx").on(table.discordId),
    uniqueIndex("user_macros_discord_id_macro_unique").on(table.discordId, table.macro),
    index("user_macros_discord_id_status_idx").on(table.discordId, table.status),
  ],
);

// ──────────────────────────────────────────────
// 6. pendingEntitlements — Queued macro grants awaiting user signup
// ──────────────────────────────────────────────
export const pendingEntitlements = pgTable(
  "pending_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    macro: varchar("macro", { length: 100 }).notNull(),
    duration: varchar("duration", { length: 20 }).notNull(),
    source: varchar("source", { length: 20 }).notNull().default("sellauth"),
    orderId: varchar("order_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("pending_entitlements_discord_id_idx").on(table.discordId),
    index("pending_entitlements_order_id_idx").on(table.orderId),
  ],
);

// ──────────────────────────────────────────────
// 7. trials — Trial records (legacy)
// ──────────────────────────────────────────────
export const trials = pgTable(
  "trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    macro: varchar("macro", { length: 100 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("trials_discord_id_macro_unique").on(table.discordId, table.macro),
  ],
);

// ──────────────────────────────────────────────
// 8. trialRegistrations — HWID-locked trial registrations
// ──────────────────────────────────────────────
export const trialRegistrations = pgTable(
  "trial_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    hwid: text("hwid").notNull(),
    macro: varchar("macro", { length: 100 }).notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("trial_registrations_hwid_unique").on(table.hwid),
    index("trial_registrations_discord_id_idx").on(table.discordId),
  ],
);

// ──────────────────────────────────────────────
// 9. announcements — In-app announcement banners
// ──────────────────────────────────────────────
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: varchar("app_id", { length: 50 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    imageUrl: text("image_url"),
    startsAt: timestamp("starts_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("announcements_app_id_idx").on(table.appId),
    index("announcements_app_id_starts_at_idx").on(table.appId, table.startsAt),
  ],
);

// ──────────────────────────────────────────────
// 10. adminLogs — Audit trail for admin actions
// ──────────────────────────────────────────────
export const adminLogs = pgTable(
  "admin_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: text("action").notNull(),
    actorDiscordId: varchar("actor_discord_id", { length: 255 }),
    targetDiscordId: varchar("target_discord_id", { length: 255 }),
    details: jsonb("details"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("admin_logs_created_at_idx").on(table.createdAt),
  ],
);

// ──────────────────────────────────────────────
// 11. desktopSessions — Auth tokens for desktop app sessions
// ──────────────────────────────────────────────
export const desktopSessions = pgTable(
  "desktop_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    hwid: text("hwid").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("desktop_sessions_token_unique").on(table.token),
    index("desktop_sessions_discord_id_idx").on(table.discordId),
  ],
);

// ──────────────────────────────────────────────
// 12. clientReports — Error reports from desktop
// ──────────────────────────────────────────────
export const clientReports = pgTable(
  "client_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }),
    type: varchar("type", { length: 20 }).notNull(),
    message: text("message"),
    stack: text("stack"),
    context: jsonb("context"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("client_reports_created_at_idx").on(table.createdAt),
    index("client_reports_discord_id_idx").on(table.discordId),
  ],
);

// ──────────────────────────────────────────────
// 13. migrationClaims — SellAuth migration claims
// ──────────────────────────────────────────────
export const migrationClaims = pgTable(
  "migration_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: varchar("discord_id", { length: 255 }),
    sellauthUsername: varchar("sellauth_username", { length: 255 }),
    orderId: varchar("order_id", { length: 255 }),
    macro: varchar("macro", { length: 100 }).notNull(),
    duration: varchar("duration", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("migration_claims_status_idx").on(table.status),
    index("migration_claims_order_id_idx").on(table.orderId),
  ],
);