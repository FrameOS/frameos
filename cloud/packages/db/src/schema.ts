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
  primaryKey,
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
  // The AI opt-out (migration 0044). Set = the account has explicitly turned
  // AI features off and nothing it does may incur AI cost;
  // resolveAiCredentials() refuses before it looks at any key. A timestamp so
  // "since when" is answerable, and null for every account that never touched
  // the switch.
  aiDisabledAt: timestamp("ai_disabled_at", { withTimezone: true }),
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
    // When the session last proved the account's credentials (sign-in, or a
    // later /api/auth/reauth). Sensitive routes require it to be recent.
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
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

// Personal API tokens (migration 0040): a bearer credential for the JSON API
// and the MCP server that stands in for the account. Hash-at-rest like a
// session; `access` is "full" or "read_only" and is mirrored by the token's
// prefix (fc_api_ / fc_apiro_) so a mutation can be refused before any lookup.
export const accountApiTokens = pgTable(
  "account_api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    access: text("access").default("full").notNull(),
    tokenHash: text("token_hash").notNull(),
    // Leading characters of the token, for telling tokens apart in a list.
    tokenHint: text("token_hint").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    accountIdx: index("account_api_tokens_account_idx").on(table.accountId),
    tokenHashUnique: uniqueIndex("account_api_tokens_token_hash_unique").on(
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
    // The publisher's one-line "what changed" note (see
    // normalizeVersionMessage). Null for versions published without one —
    // everything before this column existed, and every zip upload.
    message: text("message"),
    // The listing as it was when this version was published: description,
    // tags and category travel with the version (and inside the zip's
    // template.json) like frameosVersion always did, so a pinned version
    // says what it said. The store_scenes columns of the same names are the
    // projection of the latest version — what the store's SQL filters on.
    description: text("description"),
    tags: text("tags").array().default([]).notNull(),
    category: text("category"),
    // False on versions published before the listing and the image set were
    // recorded per version (migration 0041 stamps the latest one true);
    // readers fall back to the scene row for those. "No description, no
    // images" is a legitimate recorded state, hence a flag and not nulls.
    listingRecorded: boolean("listing_recorded").default(false).notNull(),
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

// Every image the store holds, once: keyed by the digest of its bytes, which
// is also the tail of its object key. Versions link to these
// (storeSceneVersionImages) rather than carrying rows of their own, so a
// screenshot reused across ten versions of a scene — or by a fork — is one
// object and one row. Nothing here says which scene an image belongs to;
// the links do, and an image nobody links is what the sweep script removes.
export const storeImages = pgTable("store_images", {
  sha256: text("sha256").primaryKey(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").default("image/jpeg").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// The ordered image set of one version: position 0 is the cover the store
// shows for it. Immutable with the version — reordering publishes a new one.
export const storeSceneVersionImages = pgTable(
  "store_scene_version_images",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => storeSceneVersions.id, { onDelete: "cascade" }),
    imageSha256: text("image_sha256")
      .notNull()
      .references(() => storeImages.sha256),
    position: integer("position").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.versionId, table.position] }),
    imageIdx: index("store_scene_version_images_image_idx").on(
      table.imageSha256,
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
    // A deep-sleeping (battery) frame's own forecast, from its `sleep`
    // message just before the CPU halts: when it redials next (next_wake_at),
    // when the panel refreshes next (next_render_at — later than the wake
    // when the wake is only a command check-in) and why it sleeps
    // ("battery" | "always" | "battery_critical"). Cleared on connect, so a
    // non-null next_wake_at on a disconnected frame means "asleep, back at
    // …" and a wake that never came shows as overdue. Frames on firmware
    // without the message leave all three null and the SPA estimates from
    // the power settings instead.
    nextWakeAt: timestamp("next_wake_at", { withTimezone: true }),
    nextRenderAt: timestamp("next_render_at", { withTimezone: true }),
    sleepReason: text("sleep_reason"),
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
    // IANA zone of the browser that minted the token; enrollment seeds the
    // frame's `timezone` setting from it so a new frame shows local time.
    timezone: text("timezone"),
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

// Double-entry accounting (migration 0042). Product code emits an immutable
// financial_events row; a versioned posting rule in packages/ledger turns it
// into balanced ledger_entries + ledger_postings; ledger_balances caches the
// running sum. Design: cloud/docs/accounting-todo.md.
//
// No foreign key points out of the ledger. account_id and owner_account_id
// hold an accounts uuid as a plain column, so a deleted account can neither
// take its books with it nor anonymize them — "we paid OpenAI $4.20 on
// behalf of somebody" is not an accounting record, and a provider-cost entry
// touches no customer account to recover the id from. It also keeps these
// tables a self-contained module that could move to its own database. See
// the migration header for the full argument.
//
// Database triggers make financial_events, ledger_entries and
// ledger_postings append-only — drizzle cannot express them, so read the
// migration for the one change financial_events still allows (the one-way
// processed_at stamp).
export const financialEvents = pgTable(
  "financial_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: text("event_type").notNull(),
    // An accounts uuid, deliberately unreferenced. NULL means the event
    // belongs to no customer (a provider invoice, an opening balance), never
    // "we forgot whose it was".
    accountId: uuid("account_id"),
    // Which product surface stated the fact: chat_route, stripe_webhook,
    // admin, cron, backfill.
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    // The dedupe handle — "turn:<uuid>", "stripe:evt_...". Unique, and what
    // makes replaying an event a no-op instead of a double charge.
    idempotencyKey: text("idempotency_key").notNull(),
    // Economic time (when the tokens were burned), not write time.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    // Stamped when the posting rule ran. NULL means pending or failed, which
    // is what the unposted sweep looks for.
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountOccurredIdx: index("financial_events_account_occurred_idx").on(
      table.accountId,
      table.occurredAt,
    ),
    idempotencyUnique: uniqueIndex("financial_events_idempotency_unique").on(
      table.idempotencyKey,
    ),
  }),
);

// Reporting hierarchy only: re-pointing an account at another group
// re-buckets every report and touches no posting. Moving an amount between
// accounts is a reclassification entry instead.
export const ledgerAccountGroups = pgTable(
  "ledger_account_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => ledgerAccountGroups.id,
    ),
    sortOrder: integer("sort_order").default(0).notNull(),
    ...timestamps,
  },
  (table) => ({
    codeUnique: uniqueIndex("ledger_account_groups_code_unique").on(table.code),
  }),
);

// The chart of accounts. System accounts are seeded by the migration with
// owner_account_id NULL; per-customer subaccounts
// ("liability:credits:customer:<uuid>") are created on first touch. Posting
// rules name accounts by `code`, never by id.
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    // asset | liability | equity | revenue | contra_revenue | expense
    type: text("type").notNull(),
    // debit | credit — the side a positive balance sits on.
    normalSide: text("normal_side").notNull(),
    currency: text("currency").default("USD").notNull(),
    // The customer a subaccount belongs to; NULL on system accounts. Same
    // unreferenced accounts uuid, also spelled out inside `code`.
    ownerAccountId: uuid("owner_account_id"),
    groupId: uuid("group_id").references(() => ledgerAccountGroups.id),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    codeUnique: uniqueIndex("ledger_accounts_code_unique").on(table.code),
    ownerIdx: index("ledger_accounts_owner_idx").on(table.ownerAccountId),
  }),
);

// Journal entry header. One event may produce several entries: a metered AI
// turn posts the customer charge and our provider cost as two independent
// balanced entries from the one fact.
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => financialEvents.id),
    // The posting rule that built it, and the version of that rule. Old
    // entries keep the version they were posted under; rules never
    // retroactively change what they already produced.
    entryType: text("entry_type").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    description: text("description").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reversesEntryId: uuid("reverses_entry_id").references(
      (): AnyPgColumn => ledgerEntries.id,
    ),
    // Stripe charge / balance transaction / payout id: the reconciliation
    // hook, indexed for the day the books are matched against a statement.
    externalRef: text("external_ref"),
    // Pricing snapshot (token counts, unit prices, the margin in force) so an
    // entry stays explainable after the settings behind it change.
    metadata: jsonb("metadata").default({}).notNull(),
  },
  (table) => ({
    eventIdx: index("ledger_entries_event_idx").on(table.eventId),
    occurredIdx: index("ledger_entries_occurred_idx").on(table.occurredAt),
  }),
);

// Entry lines, balanced per entry per currency. Amounts are always positive
// bigint micro-dollars; the direction carries the sign.
export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => ledgerEntries.id),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    // debit | credit
    direction: text("direction").notNull(),
    amountMicros: bigint("amount_micros", { mode: "bigint" }).notNull(),
    currency: text("currency").default("USD").notNull(),
  },
  (table) => ({
    accountIdx: index("ledger_postings_account_idx").on(table.ledgerAccountId),
    entryIdx: index("ledger_postings_entry_idx").on(table.entryId),
  }),
);

// Derived cache, signed so positive means "on this account's normal side".
// The nightly integrity check proves it equals the sum over postings; if the
// two ever disagree, the postings win.
export const ledgerBalances = pgTable("ledger_balances", {
  ledgerAccountId: uuid("ledger_account_id")
    .primaryKey()
    .references(() => ledgerAccounts.id),
  balanceMicros: bigint("balance_micros", { mode: "bigint" })
    .default(0n)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// AI metering (migration 0043). The metering subledger every ledger entry
// for a chat turn is derived from, plus the effective-dated provider price
// table and the first global settings table. Design:
// cloud/docs/accounting-todo.md §3.2.
//
// Same rule as the ledger tables above: no foreign key points out of the
// accounting module. account_id, chat_id and updated_by hold uuids as plain
// columns; event_id points *into* the module, which is allowed.

// What the provider charges, effective-dated. Micro-dollars per MILLION
// tokens — per-token cannot represent a cached gpt-4o-mini token ($0.075 per
// 1M, i.e. 0.075 micro-dollars, which as a bigint is zero).
export const aiModelPrices = pgTable(
  "ai_model_prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    model: text("model").notNull(),
    inputMicrosPerMtok: bigint("input_micros_per_mtok", {
      mode: "bigint",
    }).notNull(),
    cachedInputMicrosPerMtok: bigint("cached_input_micros_per_mtok", {
      mode: "bigint",
    }).notNull(),
    // Reasoning tokens bill as output; there is deliberately no third price.
    outputMicrosPerMtok: bigint("output_micros_per_mtok", {
      mode: "bigint",
    }).notNull(),
    currency: text("currency").default("USD").notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    modelFromUnique: uniqueIndex("ai_model_prices_model_from_unique").on(
      table.model,
      table.effectiveFrom,
    ),
    modelIdx: index("ai_model_prices_model_idx").on(
      table.model,
      table.effectiveFrom,
    ),
  }),
);

// Margin, overdraft, metering mode. Superadmin-writable and audited; every
// key has a code-level fallback so a fresh database boots with sane numbers.
export const billingSettings = pgTable("billing_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  // An accounts uuid, deliberately unreferenced.
  updatedBy: uuid("updated_by"),
});

// One row per AI turn: what it cost us, what it would cost the customer, and
// the pricing snapshot behind both numbers.
//
// Token counts here are DISJOINT, unlike the provider's: `inputTokens` is
// the UNCACHED input, `cachedInputTokens` the rest of what was sent, so each
// multiplies by its own price without a subtraction anybody can forget.
// `reasoningTokens` stays a subset of `outputTokens` and is recorded for
// analysis only — it bills as output, which is how the provider bills it.
export const aiUsageRecords = pgTable(
  "ai_usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id"),
    chatId: uuid("chat_id"),
    // The turn's own id, and the idempotency handle: this row's ledger event
    // is keyed "turn:<turnId>", so re-posting it is a replay.
    turnId: uuid("turn_id").notNull(),
    // The gate's own name for the product surface ("scene_chat", ...): an
    // enum the server owns, because it decides whether a turn is absorbed.
    surface: text("surface"),
    // The client's hint about where in the product the turn came from
    // ("editor", "frame", "store"). Display only; nothing prices on it.
    context: text("context"),
    model: text("model").notNull(),
    // Whose key paid the provider: "account" (the customer's own — we incur
    // nothing and charge nothing), "shared" (the operator's key, our cost,
    // not billed), "platform" (our key, billed — Phase 3).
    credentialSource: text("credential_source").notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
    rounds: integer("rounds").default(0).notNull(),
    costMicros: bigint("cost_micros", { mode: "bigint" }).default(0n).notNull(),
    priceMicros: bigint("price_micros", { mode: "bigint" })
      .default(0n)
      .notNull(),
    currency: text("currency").default("USD").notNull(),
    pricing: jsonb("pricing").default({}).notNull(),
    // "shadow" rows are measurement only and never post, whatever they
    // priced at; "live" rows post, and the sweep chases the ones that did
    // not. Stamped per row rather than read from settings at sweep time, so
    // flipping the switch cannot retroactively bill a week of shadow turns.
    meteringMode: text("metering_mode").default("shadow").notNull(),
    eventId: uuid("event_id").references(() => financialEvents.id),
    // Set when the charge entry this record posted was reversed: the page
    // and the daily cap then stop counting it (§9.2 item 11).
    creditedAt: timestamp("credited_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    accountCreatedIdx: index("ai_usage_records_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    // The daily cap and the /account/ai page both window on occurred_at —
    // when the tokens burned, not when the row was written (migration 0044).
    accountOccurredIdx: index("ai_usage_records_account_occurred_idx").on(
      table.accountId,
      table.occurredAt,
    ),
    turnUnique: uniqueIndex("ai_usage_records_turn_unique").on(table.turnId),
  }),
);

// Plans and subscriptions (migration 0045). What varies down the ladder is
// the MARGIN on metered AI rather than access to a feature — a plan is a
// better rate on something everybody may already use, which is why there is
// no "has_ai" column here. Design: cloud/docs/accounting-todo.md §0.1, §3.6.
//
// These are NOT ledger tables: they reference `accounts` normally, because a
// subscription is product state. What the ledger sees is the entries §3.6's
// recipes post, and those name the account the same unreferenced way every
// other financial event does.
export const billingPlans = pgTable("billing_plans", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  priceMicros: bigint("price_micros", { mode: "bigint" }).notNull(),
  currency: text("currency").default("USD").notNull(),
  period: text("period").default("month").notNull(),
  // Overrides the global `ai_margin_percent` for accounts on this plan, and
  // is snapshotted per usage record exactly as the global one always was.
  marginBasisPoints: integer("margin_basis_points").notNull(),
  // cloud_rendered_frames, backup_bytes, frame_log_bytes,
  // private_scene_bytes, frames. Read by src/lib/usage.ts, never by the
  // ledger: a plan's entitlements are not accounting facts.
  entitlements: jsonb("entitlements").default({}).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  public: boolean("public").default(true).notNull(),
  ...timestamps,
});

// One row per account, at most. No row means PAYG — the same thing as a row
// pointing at the payg plan, so that enrolling every existing account is not
// a prerequisite for shipping.
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // An accounts uuid, unreferenced like every other billing table (§2.1).
    // Migration 0045 had it cascading from accounts, which took a charged
    // period's row with the account and stranded its deferred revenue; 0046
    // dropped the reference.
    accountId: uuid("account_id").notNull(),
    planCode: text("plan_code")
      .notNull()
      .references(() => billingPlans.code),
    // A downgrade lands here and moves into plan_code at the next rollover
    // (§9.2 item 6); an upgrade switches plan_code at once, prorated.
    nextPlanCode: text("next_plan_code"),
    status: text("status").default("active").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Set when the user cancels: the plan runs to the end of the paid period
    // and stops. Nothing is refunded by default.
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    accountUnique: uniqueIndex("subscriptions_account_unique").on(
      table.accountId,
    ),
  }),
);

// One row per billed period: charged at period start, recognized at period
// end, both idempotent on this row's id so the nightly job may run twice or
// miss a night without double-charging or losing a period.
export const subscriptionPeriods = pgTable(
  "subscription_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    // Snapshotted, not joined: a period is billed at the price and margin in
    // force when it started, whatever the plan row says afterwards.
    planCode: text("plan_code").notNull(),
    priceMicros: bigint("price_micros", { mode: "bigint" }).notNull(),
    marginBasisPoints: integer("margin_basis_points").notNull(),
    currency: text("currency").default("USD").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    recognizedAt: timestamp("recognized_at", { withTimezone: true }),
    // Returned to the receivable before period end (§3.6's refund recipe);
    // recognition then earns price − this, never the full price.
    refundedMicros: bigint("refunded_micros", { mode: "bigint" })
      .default(0n)
      .notNull(),
    // Recognised as revenue so far (migration 0047). The nightly job earns
    // each period daily, pro rata by whole days served; this is the cursor
    // that keeps that step idempotent, and at `recognized_at` it equals
    // price − refunded.
    recognizedMicros: bigint("recognized_micros", { mode: "bigint" })
      .default(0n)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    periodUnique: uniqueIndex("subscription_periods_unique").on(
      table.subscriptionId,
      table.periodStart,
    ),
  }),
);
