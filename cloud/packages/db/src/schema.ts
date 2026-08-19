import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
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
  // Store publish ban: the account keeps working, but
  // any new store publish is rejected until a superadmin lifts the ban.
  storeBanReason: text("store_ban_reason"),
  storeBannedAt: timestamp("store_banned_at", { withTimezone: true }),
  // Intentionally NOT unique: account identity is keyed on provider issuer +
  // subject (see account_identities). Never use this column for account lookup
  // or recovery decisions; it is a display/contact snapshot only.
  primaryEmail: text("primary_email"),
  // Verified publisher: superadmin-granted trust mark. Today its only consumer
  // is the AI chat's store-catalog tool, which recommends public scenes from
  // verified publishers only. Null = not verified.
  verifiedPublisherAt: timestamp("verified_publisher_at", {
    withTimezone: true,
  }),
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
//
// Sessions slide: expires_at is an *idle* deadline that activity pushes
// forward (see refreshSessionRow in apps/auth-web), while
// absolute_expires_at is the hard ceiling a session can never outlive no
// matter how active it is. last_used_at throttles the refresh so a busy tab
// does not rewrite the row on every request.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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

// Optional second factors (migration 0034). Two-factor is ON for an account
// exactly when it has a confirmed TOTP secret or at least one passkey — the
// credentials are the flag, so nothing can drift out of sync with them.
export const accountTotp = pgTable("account_totp", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  // Null until the user proves they scanned the secret with one valid code.
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  // AES-256-GCM under FRAMEOS_CLOUD_ENCRYPTION_KEY (lib/secrets encryptSecret).
  encryptedSecret: text("encrypted_secret").notNull(),
  // The 30-second step of the last accepted code: replay protection.
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  ...timestamps,
});

export const accountPasskeys = pgTable(
  "account_passkeys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    aaguid: text("aaguid"),
    backedUp: boolean("backed_up").default(false).notNull(),
    counter: bigint("counter", { mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // base64url, as WebAuthn hands it to us; globally unique by design.
    credentialId: text("credential_id").notNull(),
    deviceType: text("device_type"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    name: text("name").notNull(),
    publicKey: bytea("public_key").notNull(),
    transports: text("transports").array(),
  },
  (table) => ({
    accountIdx: index("account_passkeys_account_idx").on(table.accountId),
    credentialIdUnique: uniqueIndex("account_passkeys_credential_id_unique").on(
      table.credentialId,
    ),
  }),
);

// Single-use recovery codes, shown once at generation and stored hashed.
export const accountRecoveryCodes = pgTable(
  "account_recovery_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => ({
    accountIdx: index("account_recovery_codes_account_idx").on(table.accountId),
    hashUnique: uniqueIndex("account_recovery_codes_hash_unique").on(
      table.accountId,
      table.codeHash,
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
    // Preview bytes, in Postgres (legacy rows) or object storage (everything
    // written since 0032). previewImageSizeBytes is recorded either way, so
    // storage accounting no longer needs octet_length() on the blob.
    previewImage: bytea("preview_image"),
    previewObjectKey: text("preview_object_key"),
    previewImageHeight: integer("preview_image_height"),
    previewImageSizeBytes: integer("preview_image_size_bytes"),
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
    // Exactly one of `content` and `objectKey` is set. Publishing writes the
    // zip to object storage and leaves `content` null; the column survives as
    // the other half of migration 0032's contract, and readBlob() serves
    // whichever a row carries (cloud/apps/auth-web/src/lib/blobs.ts).
    content: bytea("content"),
    objectKey: text("object_key"),
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
    content: bytea("content"),
    objectKey: text("object_key"),
    contentType: text("content_type").default("image/jpeg").notNull(),
    position: integer("position").default(0).notNull(),
    sizeBytes: integer("size_bytes"),
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

// User reports against store scenes. A partial unique
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
// the redirect URL is a random token; the row stores only references — the
// signed-in account and identity — and the profile claims are resolved fresh
// at the token endpoint, so the row carries no PII snapshot.
export const frameosLoginCodes = pgTable(
  "frameos_login_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // The identity the user signed in with, so redemption can report the
    // right provider claims. SET NULL on delete: an identity unlinked in the
    // two-minute code window simply invalidates the code.
    identityId: uuid("identity_id").references(() => accountIdentities.id, {
      onDelete: "set null",
    }),
    linkedClientId: uuid("linked_client_id")
      .notNull()
      .references(() => linkedClients.id, { onDelete: "cascade" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountIdx: index("frameos_login_codes_account_idx").on(table.accountId),
    codeHashUnique: uniqueIndex("frameos_login_codes_code_hash_unique").on(
      table.codeHash,
    ),
    linkedClientIdx: index("frameos_login_codes_linked_client_idx").on(
      table.linkedClientId,
    ),
  }),
);

// Shared fixed-window rate-limit buckets so limits hold across app replicas
// and survive restarts (the in-memory fallback in apps/auth-web is
// per-instance). Rows are upserted atomically; expired rows are swept
// opportunistically from the application.
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

// Account-level service settings (Unsplash/OpenAI/Home Assistant/... API keys
// scenes use), one row per settings group — the cloud mirror of the backend's
// settings table (backend/app/models/settings.py). Which groups and fields
// are storable is enforced in auth-web (src/lib/account-settings.ts), not
// here.
export const accountSettings = pgTable(
  "account_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountKeyUnique: uniqueIndex("account_settings_account_key_unique").on(
      table.accountId,
      table.key,
    ),
  }),
);

// Cloud-managed frames (wire contract: docs/cloud-frames.md at the repo
// root; design: cloud/docs/cloud-frames.md). A frame is 1:1 with a
// linked_clients row (client_kind = "frame"). We store only the device's
// Ed25519 public key — the control plane can never impersonate a device.
export const frames = pgTable(
  "frames",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    linkedClientId: uuid("linked_client_id")
      .notNull()
      .references(() => linkedClients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // base64 raw Ed25519 public key, verify-only. Never a private key.
    publicKey: text("public_key").notNull(),
    hardware: jsonb("hardware"),
    frameosVersion: text("frameos_version"),
    // pending (claim-token enrollment awaiting owner confirmation) | active
    // | revoked. No scene push is accepted while pending.
    status: text("status").default("pending").notNull(),
    // Hub liveness, DB-keyed so a second instance stays possible.
    connected: boolean("connected").default(false).notNull(),
    hubSessionId: text("hub_session_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastState: jsonb("last_state"),
    lastMetrics: jsonb("last_metrics"),
    // "Someone had this frame's images on screen, roughly now." Stamped by
    // every surface that renders a preview, throttled to one write per frame
    // per 30s, and read by the hub to decide whether a device's "render"
    // announcement is worth an asset_get. An unwatched frame is never
    // scraped (lib/frames.ts, previewWatchWindowMs).
    previewWatchedAt: timestamp("preview_watched_at", { withTimezone: true }),
    // Wake/event schedule pushed to the device via set_schedule (shape per
    // embedded/esp32/main/fos_schedule.h: {events: [...], disabled?}). Stored
    // so the panel can render it and edits survive the device being offline.
    schedule: jsonb("schedule"),
    // Last-pushed declarative settings (allowedFrameSettings in
    // auth-web's src/lib/frames.ts — interval/rotate/…). Devices own their
    // own copy; this is the control plane's mirror so the Settings panel
    // renders what was pushed instead of blanks after a reload. `name` is
    // NOT stored here: frames.name is authoritative for the display name.
    settings: jsonb("settings"),
    // Which service-settings GROUPS ("unsplash", "openAI", …) this frame's
    // assigned scenes declare, denormalized from the scenes themselves.
    // Recomputing it means unzipping every assigned scene version (zips are
    // capped at 32 MiB apiece), which is far too expensive to do on every
    // device poll of /api/frames/{id}/service-settings — so it is written
    // wherever scenes are assigned. NULL means "never computed": the pull
    // route computes it once and backfills. Never holds a credential, only
    // group names.
    serviceSettingGroups: jsonb("service_setting_groups"),
    // Desired vs device-acked interpreted-scene payload checksums.
    assignedChecksum: text("assigned_checksum"),
    scenesChecksum: text("scenes_checksum"),
    // Per-scene deploy ledger: {storeSceneId: {version, checksum}}.
    // assigned_scene_state is rewritten with every assignment push (the
    // per-scene slices of the payload assigned_checksum covers);
    // deployed_scene_state is the hub's copy of it, taken when the device
    // acks the matching set checksum — the cloud's equivalent of the
    // backend's last_successful_deploy.scenes, so the workspace can say
    // WHICH scene is not on the frame yet instead of flagging all of them.
    assignedSceneState: jsonb("assigned_scene_state"),
    deployedSceneState: jsonb("deployed_scene_state"),
    // Provisioning intent carried from the enrollment token: copy this
    // frame's scenes onto the new one when the owner CONFIRMS it. Cleared
    // once applied, so it never fires twice. A pending frame has been sent
    // nothing — confirmation is still what authorizes the first push.
    sceneSourceFrameId: uuid("scene_source_frame_id").references(
      (): AnyPgColumn => frames.id,
      { onDelete: "set null" },
    ),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("frames_account_idx").on(table.accountId),
    linkedClientUnique: uniqueIndex("frames_linked_client_unique").on(
      table.linkedClientId,
    ),
  }),
);

// Claim tokens minted by "Add frame" (FRCT_…), hashed at rest. Single-use
// by default; the SD-image download mints multi-use tokens (max_uses > 1)
// so one image flashed to many cards enrolls many frames. used_at is set
// when the budget is spent.
export const frameEnrollmentTokens = pgTable(
  "frame_enrollment_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    name: text("name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    maxUses: integer("max_uses").default(1).notNull(),
    useCount: integer("use_count").default(0).notNull(),
    // History: which frame this token enrolled. Written AFTER redemption, so
    // it says nothing about what the token may do.
    frameId: uuid("frame_id").references(() => frames.id, {
      onDelete: "set null",
    }),
    // Intent: a token minted for an EXISTING frame (re-enrollment — moving a
    // board, or rescuing one whose NVS was blanked). Redemption re-keys that
    // frame in place instead of inserting a new row, so this must be a
    // separate column from `frame_id` above: a multi-use SD-image token picks
    // up a frame_id on its first redemption, and reading that back as
    // "bound" would re-key the first board's frame on every later card.
    // Always max_uses = 1, short TTL, and cascade-deleted with its frame —
    // a token that can only re-key a row that no longer exists is dead.
    boundFrameId: uuid("bound_frame_id").references(() => frames.id, {
      onDelete: "cascade",
    }),
    // Provisioning intent: every frame this token enrolls starts with the
    // scenes of THIS frame. Lives on the token because the browser that
    // built the SD image is long gone by the time the card is flashed;
    // copied onto each enrolled frame, because a multi-use card enrolls many
    // and the token's own frame_id records only the last one.
    sceneSourceFrameId: uuid("scene_source_frame_id").references(
      () => frames.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex(
      "frame_enrollment_tokens_token_hash_unique",
    ).on(table.tokenHash),
    accountIdx: index("frame_enrollment_tokens_account_idx").on(
      table.accountId,
    ),
  }),
);

// Which store/account scenes a frame renders. scene_version NULL tracks the
// latest non-yanked version. Assignment writes enqueue a set_scenes command.
export const frameSceneAssignments = pgTable(
  "frame_scene_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    frameId: uuid("frame_id")
      .notNull()
      .references(() => frames.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => storeScenes.id, { onDelete: "cascade" }),
    sceneVersion: integer("scene_version"),
    position: integer("position").default(0).notNull(),
    ...timestamps,
  },
  (table) => ({
    frameSceneUnique: uniqueIndex(
      "frame_scene_assignments_frame_scene_unique",
    ).on(table.frameId, table.sceneId),
    frameIdx: index("frame_scene_assignments_frame_idx").on(
      table.frameId,
      table.position,
    ),
  }),
);

// Durable per-frame command queue: survives restarts, drained in creation
// order on (re)connect. The hub marks sent/acked/failed; expired rows are
// swept by db-cleanup.sh.
export const frameCommands = pgTable(
  "frame_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    frameId: uuid("frame_id")
      .notNull()
      .references(() => frames.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    // pending | sent | acked | failed | expired
    status: text("status").default("pending").notNull(),
    error: text("error"),
    createdByAccountId: uuid("created_by_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    frameStatusIdx: index("frame_commands_frame_status_idx").on(
      table.frameId,
      table.status,
      table.createdAt,
    ),
  }),
);

// Cached per-frame asset listing (the `assets` reply to an `assets_list`
// verb, docs/cloud-frames.md). One row per frame — latest listing only; the
// hub rejects oversized listings instead of storing truncated ones.
export const frameAssets = pgTable("frame_assets", {
  frameId: uuid("frame_id")
    .primaryKey()
    .references(() => frames.id, { onDelete: "cascade" }),
  // [{path, size, mtime, is_dir}…] with device-relative paths.
  payload: jsonb("payload").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  // The device bounded the listing (its cap, not ours): the UI may say
  // "showing the first N files" but must never present it as complete.
  truncated: boolean("truncated").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Cached asset bytes (reassembled `asset_chunk` streams). A small per-frame
// LRU so thumbnails and repeat downloads stop round-tripping to the device;
// storeFrameAssetFile prunes past the per-frame caps in the same transaction.
export const frameAssetFiles = pgTable(
  "frame_asset_files",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    frameId: uuid("frame_id")
      .notNull()
      .references(() => frames.id, { onDelete: "cascade" }),
    // Device-relative path, exactly as sent in the asset_get payload.
    path: text("path").notNull(),
    thumb: boolean("thumb").default(false).notNull(),
    contentType: text("content_type").notNull(),
    content: bytea("content"),
    objectKey: text("object_key"),
    sizeBytes: integer("size_bytes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    frameAssetIdx: uniqueIndex("frame_asset_files_frame_path_thumb_idx").on(
      table.frameId,
      table.path,
      table.thumb,
    ),
  }),
);

// Retained device logs (scope telemetry:logs). size_bytes is precomputed so
// storage-usage sums stay cheap; retention is capped per frame on insert and
// in db-cleanup.sh. Retained bytes count toward the account's storage usage.
export const frameLogs = pgTable(
  "frame_logs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    frameId: uuid("frame_id")
      .notNull()
      .references(() => frames.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    frameIdx: index("frame_logs_frame_idx").on(table.frameId, table.id),
  }),
);

// Retained metrics samples (scope telemetry:metrics) — the history behind the
// SPA's Metrics panel (/metrics + /metrics/recent), while frames.last_metrics
// keeps only the newest sample. Same shape and retention doctrine as
// frame_logs: size_bytes precomputed, per-frame cap pruned on insert.
export const frameMetrics = pgTable(
  "frame_metrics",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    frameId: uuid("frame_id")
      .notNull()
      .references(() => frames.id, { onDelete: "cascade" }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    frameIdx: index("frame_metrics_frame_idx").on(table.frameId, table.id),
  }),
);

// AI chat conversations (the workspace's AI drawer). The chat id is minted by
// the SPA (uuid) before the first message, so the id is client-supplied —
// ownership is enforced on every read/write, and an id collision with another
// account's chat is refused rather than adopted. context_type/context_id
// mirror the SPA's ChatSummary shape ("frame" | "scene" | "app", with the
// scene id or scene::node id as the context id).
export const aiChats = pgTable(
  "ai_chats",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // Frame deletion should not erase the account's chat history — the
    // conversations are about scenes and setup, not just one device.
    frameId: uuid("frame_id").references(() => frames.id, {
      onDelete: "set null",
    }),
    contextType: text("context_type").default("frame").notNull(),
    contextId: text("context_id"),
    title: text("title"),
    messageCount: integer("message_count").default(0).notNull(),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("ai_chats_account_idx").on(table.accountId, table.updatedAt),
    frameIdx: index("ai_chats_frame_idx").on(table.frameId),
  }),
);

// One row per chat turn. `content` is the display text; `tool` labels what the
// assistant did (reply / build_scene / modify_scene); `payload` carries
// structured extras (generated scenes) that history reloads may surface later.
export const aiChatMessages = pgTable(
  "ai_chat_messages",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => aiChats.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    tool: text("tool"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    chatIdx: index("ai_chat_messages_chat_idx").on(table.chatId, table.id),
  }),
);
