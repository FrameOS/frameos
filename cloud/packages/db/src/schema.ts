import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const consentDecision = pgEnum("consent_decision", [
  "approved",
  "denied",
  "expired",
]);
export const deviceAuthorizationStatus = pgEnum("device_authorization_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  displayName: text("display_name"),
  isSuperadmin: boolean("is_superadmin").default(false).notNull(),
  // Null for accounts that only sign in through an external provider.
  passwordHash: text("password_hash"),
  // Store publish ban (STORE-TODO Phase 3): the account keeps working, but
  // any new store publish is rejected until a superadmin lifts the ban.
  storeBanReason: text("store_ban_reason"),
  storeBannedAt: timestamp("store_banned_at", { withTimezone: true }),
  // Intentionally NOT unique: account identity is keyed on provider issuer +
  // subject (see account_identities). Never use this column for account lookup
  // or recovery decisions; it is a display/contact snapshot only.
  primaryEmail: text("primary_email"),
  ...timestamps,
});

export const accountIdentities = pgTable(
  "account_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    emailSnapshot: text("email_snapshot"),
    emailVerified: boolean("email_verified").default(false).notNull(),
    providerIssuer: text("provider_issuer").notNull(),
    providerKey: text("provider_key").notNull(),
    providerSubject: text("provider_subject").notNull(),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("account_identities_account_idx").on(table.accountId),
    providerSubjectUnique: uniqueIndex(
      "account_identities_provider_subject_unique",
    ).on(table.providerIssuer, table.providerSubject),
  }),
);

export const linkedClients = pgTable(
  "linked_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // "backend" (a FrameOS backend install) or "frame" (a frame linked
    // directly, without a backend).
    clientKind: text("client_kind").default("backend").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastTokenRotationAt: timestamp("last_token_rotation_at", {
      withTimezone: true,
    }),
    localOrigin: text("local_origin"),
    // Previous link token kept valid for a short grace window after rotation so
    // a backend that never received the rotation response is not locked out.
    previousTokenExpiresAt: timestamp("previous_token_expires_at", {
      withTimezone: true,
    }),
    previousTokenReference: text("previous_token_reference"),
    providerClientMetadata: jsonb("provider_client_metadata"),
    publicDisplayName: text("public_display_name").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenReference: text("token_reference").notNull(),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("linked_clients_account_idx").on(table.accountId),
    previousTokenReferenceIdx: index(
      "linked_clients_previous_token_reference_idx",
    ).on(table.previousTokenReference),
    tokenReferenceUnique: uniqueIndex(
      "linked_clients_token_reference_unique",
    ).on(table.tokenReference),
  }),
);

export const connectedBackends = pgTable(
  "connected_backends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    capabilities: jsonb("capabilities"),
    lastHealthPayload: jsonb("last_health_payload"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    linkedClientId: uuid("linked_client_id")
      .notNull()
      .references(() => linkedClients.id, { onDelete: "cascade" }),
    reportedFrameosVersion: text("reported_frameos_version"),
    ...timestamps,
  },
  (table) => ({
    linkedClientUnique: uniqueIndex(
      "connected_backends_linked_client_unique",
    ).on(table.linkedClientId),
  }),
);

export const deviceAuthorizationRequests = pgTable(
  "device_authorization_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByAccountId: uuid("approved_by_account_id").references(
      () => accounts.id,
      {
        onDelete: "set null",
      },
    ),
    backendMetadata: jsonb("backend_metadata"),
    clientKind: text("client_kind").default("backend").notNull(),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    deviceCodeHash: text("device_code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    intervalSeconds: integer("interval_seconds").default(5).notNull(),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    linkedClientId: uuid("linked_client_id").references(
      () => linkedClients.id,
      {
        onDelete: "set null",
      },
    ),
    localOrigin: text("local_origin"),
    pollCount: integer("poll_count").default(0).notNull(),
    publicDisplayName: text("public_display_name").notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    requestedScopes: text("requested_scopes").array().notNull(),
    status: deviceAuthorizationStatus("status").default("pending").notNull(),
    tokenReference: text("token_reference"),
    // Set when this request changes the scopes of an existing linked client
    // instead of creating a new one; approval rewrites that client's granted
    // scopes in place and the link token stays the same.
    upgradeLinkedClientId: uuid("upgrade_linked_client_id").references(
      () => linkedClients.id,
      { onDelete: "cascade" },
    ),
    userCodeDisplay: text("user_code_display").notNull(),
    userCodeHash: text("user_code_hash").notNull(),
    ...timestamps,
  },
  (table) => ({
    approvedByAccountIdx: index(
      "device_authorization_requests_approved_by_account_idx",
    ).on(table.approvedByAccountId),
    upgradeLinkedClientIdx: index(
      "device_authorization_requests_upgrade_linked_client_idx",
    ).on(table.upgradeLinkedClientId),
    deviceCodeUnique: uniqueIndex(
      "device_authorization_requests_device_code_unique",
    ).on(table.deviceCodeHash),
    linkedClientIdx: index(
      "device_authorization_requests_linked_client_idx",
    ).on(table.linkedClientId),
    statusIdx: index("device_authorization_requests_status_idx").on(
      table.status,
    ),
    userCodeUnique: uniqueIndex(
      "device_authorization_requests_user_code_unique",
    ).on(table.userCodeHash),
  }),
);

export const consentEvents = pgTable(
  "consent_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    decision: consentDecision("decision").notNull(),
    ipAddress: text("ip_address"),
    linkedClientId: uuid("linked_client_id").references(
      () => linkedClients.id,
      {
        onDelete: "set null",
      },
    ),
    scopes: text("scopes").array().notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountIdx: index("consent_events_account_idx").on(table.accountId),
    linkedClientIdx: index("consent_events_linked_client_idx").on(
      table.linkedClientId,
    ),
  }),
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actor: jsonb("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata"),
    target: jsonb("target"),
  },
  (table) => ({
    accountIdx: index("audit_events_account_idx").on(table.accountId),
    eventTypeIdx: index("audit_events_event_type_idx").on(table.eventType),
  }),
);

// Server-side session records backing the session cookie JWT. A session is
// valid only while its row is unrevoked and unexpired, which makes logout and
// account-compromise revocation effective immediately.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountIdx: index("sessions_account_idx").on(table.accountId),
    tokenHashUnique: uniqueIndex("sessions_token_hash_unique").on(
      table.tokenHash,
    ),
  }),
);

// Single-use password reset tokens. The emailed link carries the raw token;
// only its hash is stored, and redemption marks the row used so a leaked link
// cannot be replayed.
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    tokenHash: text("token_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountIdx: index("password_reset_tokens_account_idx").on(table.accountId),
    tokenHashUnique: uniqueIndex("password_reset_tokens_token_hash_unique").on(
      table.tokenHash,
    ),
  }),
);

// Single-use email verification tokens for password signups. Redemption
// flips email_verified on the password identity.
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    tokenHash: text("token_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountIdx: index("email_verification_tokens_account_idx").on(
      table.accountId,
    ),
    tokenHashUnique: uniqueIndex(
      "email_verification_tokens_token_hash_unique",
    ).on(table.tokenHash),
  }),
);

// Config backups pushed by linked backends and frames (backup:scenes /
// backup:frames scopes). Owned by the account so a reinstalled backend that
// relinks to the same account can still restore; linked_client_id records
// which install pushed the copy.
export const clientBackups = pgTable(
  "client_backups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    content: bytea("content").notNull(),
    contentType: text("content_type"),
    itemKey: text("item_key").notNull(),
    kind: text("kind").notNull(),
    linkedClientId: uuid("linked_client_id").references(
      () => linkedClients.id,
      { onDelete: "set null" },
    ),
    name: text("name"),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("client_backups_account_idx").on(table.accountId),
    accountKindItemUnique: uniqueIndex(
      "client_backups_account_kind_item_unique",
    ).on(table.accountId, table.kind, table.itemKey),
    linkedClientIdx: index("client_backups_linked_client_idx").on(
      table.linkedClientId,
    ),
  }),
);

// Scenes (template zips) published to the FrameOS store. A scene row is the
// package identity: slug, ownership, visibility, moderation state, and the
// denormalized latest version. The actual payloads live in
// store_scene_versions, which are immutable npm-style — a publish always
// appends a new version, so a compromised account can't silently swap bytes
// under an existing version.
export const storeScenes = pgTable(
  "store_scenes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Curated shelf on the store front. One of the fixed taxonomy slugs
    // (see storeCategories in the app); null = not yet categorized.
    category: text("category"),
    description: text("description"),
    downloadCount: integer("download_count").default(0).notNull(),
    // Curated by superadmins; null = not featured. A timestamp instead of a
    // boolean so the homepage can order the featured shelf by recency.
    featuredAt: timestamp("featured_at", { withTimezone: true }),
    // Minimum compatible FrameOS version of the latest payload (from
    // template.json; exports conservatively stamp their current version).
    frameosVersion: text("frameos_version"),
    // Which install pushed the most recent version.
    linkedClientId: uuid("linked_client_id").references(
      () => linkedClients.id,
      { onDelete: "set null" },
    ),
    latestVersion: integer("latest_version").default(0).notNull(),
    name: text("name").notNull(),
    previewImage: bytea("preview_image"),
    previewImageHeight: integer("preview_image_height"),
    previewImageType: text("preview_image_type"),
    previewImageWidth: integer("preview_image_width"),
    pulledAt: timestamp("pulled_at", { withTimezone: true }),
    pulledReason: text("pulled_reason"),
    // Risk flags of the latest version (e.g. 'shell'), denormalized here so
    // listings can badge scenes without joining versions.
    riskFlags: text("risk_flags").array().default([]).notNull(),
    // High-entropy sharing secret: ?share={token} grants read access to a
    // private scene (page, zip, images) without an account. Never rendered
    // to anyone but the owner.
    shareToken: uuid("share_token").defaultRandom().notNull(),
    slug: text("slug").notNull(),
    // "active" | "pulled" — pulled scenes are hidden everywhere and their
    // downloads return 410, the fast moderation kill switch.
    status: text("status").default("active").notNull(),
    // Publisher-assigned tags (short lowercase slugs; see normalizeTags).
    tags: text("tags").array().default([]).notNull(),
    // "private" | "public" — private scenes are visible only to their owner.
    visibility: text("visibility").default("private").notNull(),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("store_scenes_account_idx").on(table.accountId),
    categoryIdx: index("store_scenes_category_idx").on(table.category),
    slugUnique: uniqueIndex("store_scenes_slug_unique").on(table.slug),
    visibilityStatusIdx: index("store_scenes_visibility_status_idx").on(
      table.visibility,
      table.status,
    ),
  }),
);

// Immutable published payloads. yanked_at soft-hides a bad version from
// installs (crates.io-style yank) while keeping the bytes for anyone who
// needs to audit what was actually served.
export const storeSceneVersions = pgTable(
  "store_scene_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    content: bytea("content").notNull(),
    contentType: text("content_type").default("application/zip").notNull(),
    // Minimum compatible FrameOS version declared by this payload.
    frameosVersion: text("frameos_version"),
    publishedByLinkedClientId: uuid("published_by_linked_client_id").references(
      () => linkedClients.id,
      { onDelete: "set null" },
    ),
    // Computed at publish from the scenes JSON (see detectRiskFlags).
    riskFlags: text("risk_flags").array().default([]).notNull(),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => storeScenes.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    version: integer("version").notNull(),
    yankedAt: timestamp("yanked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sceneIdx: index("store_scene_versions_scene_idx").on(table.sceneId),
    sceneVersionUnique: uniqueIndex("store_scene_versions_scene_version_unique").on(
      table.sceneId,
      table.version,
    ),
  }),
);

// Additional gallery images for a store scene, uploaded by the owner from
// the scene page. The first image becomes the ZIP preview when the separate
// primary preview on store_scenes is absent.
export const storeSceneImages = pgTable(
  "store_scene_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    content: bytea("content").notNull(),
    contentType: text("content_type").default("image/jpeg").notNull(),
    position: integer("position").default(0).notNull(),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => storeScenes.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sceneIdx: index("store_scene_images_scene_idx").on(
      table.sceneId,
      table.position,
    ),
  }),
);

// User reports against store scenes (STORE-TODO Phase 3). A partial unique
// index in the migration allows one open report per (scene, reporter);
// superadmins resolve reports from the admin queue.
export const storeSceneReports = pgTable(
  "store_scene_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reason: text("reason").notNull(),
    reporterAccountId: uuid("reporter_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByAccountId: uuid("resolved_by_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => storeScenes.id, { onDelete: "cascade" }),
    // "open" | "resolved"
    status: text("status").default("open").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    sceneIdx: index("store_scene_reports_scene_idx").on(table.sceneId),
    statusIdx: index("store_scene_reports_status_idx").on(table.status),
  }),
);

// Single-use opaque codes for the FrameOS backend login handoff. The code in
// the redirect URL is a random token; profile claims live only in this row and
// are released once, to the authenticated linked client, at the token endpoint.
export const frameosLoginCodes = pgTable(
  "frameos_login_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    linkedClientId: uuid("linked_client_id")
      .notNull()
      .references(() => linkedClients.id, { onDelete: "cascade" }),
    profile: jsonb("profile").notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    codeHashUnique: uniqueIndex("frameos_login_codes_code_hash_unique").on(
      table.codeHash,
    ),
    linkedClientIdx: index("frameos_login_codes_linked_client_idx").on(
      table.linkedClientId,
    ),
  }),
);
