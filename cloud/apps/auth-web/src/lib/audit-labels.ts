// Human-readable rendering of audit_events rows for the account activity
// feed. Unknown event types fall back to the raw type so new events are never
// silently invisible.

const eventLabels: Record<string, string> = {
  "account.data_exported": "Account data exported",
  "account.email_verified": "Email address verified",
  "account.password_changed": "Password changed",
  "account.password_reset": "Password reset completed",
  "account.password_reset_requested": "Password reset requested",
  "account.passkey_added": "Passkey added",
  "account.passkey_removed": "Passkey removed",
  "account.passkey_renamed": "Passkey renamed",
  "account.reauthenticated": "Credentials re-confirmed for a sensitive action",
  "account.reauthentication_failed": "Credential re-check failed",
  "account.recovery_codes_regenerated": "Recovery codes regenerated",
  "account.second_factor_failed": "Second-factor check failed",
  "account.settings_updated": "Account settings updated",
  "account.signed_in": "Signed in",
  "account.totp_disabled": "Authenticator app removed",
  "account.totp_enabled": "Authenticator app enabled",
  "account.two_factor_disabled": "Two-factor authentication turned off",
  "account.self_deleted": "Account deleted by its owner",
  "account.signed_up": "Account created",
  "admin.account_deleted": "Account deleted by an admin",
  "admin.sessions_revoked": "Sessions revoked by an admin",
  "backend.inventory_synced": "Backend synced its status",
  "backup.deleted": "Backup deleted",
  "backup.saved": "Backup saved",
  "device_authorization.approved": "Device link approved",
  "device_authorization.denied": "Device link denied",
  "frame.asset_deleted": "Frame file deleted",
  "frame.asset_mkdir": "Frame folder created",
  "frame.asset_renamed": "Frame file renamed",
  "frame.asset_uploaded": "File uploaded to a frame",
  "frame.assets_synced": "Fonts synced to a frame",
  "frame.claim_token_created": "Frame claim code created",
  "frame.claim_tokens_recycled": "Unused frame claim codes recycled",
  "frame.command_cancelled": "Queued frame command cancelled",
  "frame.command_sent": "Command sent to a frame",
  "frame.confirmed": "Frame enrollment confirmed",
  "frame.connected": "Frame connected",
  "frame.deleted": "Frame deleted",
  "frame.disconnected": "Frame disconnected",
  "frame.enrolled": "Frame enrolled",
  "frame.firmware_version_changed": "Frame firmware version changed",
  "frame.re_enrolled": "Frame re-enrolled (re-keyed in place)",
  "frame.rebind_token_created": "Frame re-enrollment code created",
  "frame.renamed": "Frame renamed",
  "frame.revoked": "Frame revoked",
  "frame.scenes_applied": "Assigned scenes applied by the frame",
  "frame.scenes_assigned": "Scenes assigned to a frame",
  "frame.schedule_pushed": "Frame schedule updated",
  "frame.service_settings_scope_changed":
    "Frame access to service API keys changed",
  "frame.session_kicked": "Frame session closed by the cloud",
  "frame.settings_pushed": "Frame settings updated",
  "frame.telemetry_scope_changed": "Frame log and metric shipping changed",
  "linked_client.revoked": "Linked device revoked",
  "linked_client.scopes_reduced": "Enabled features reduced",
  "linked_client.scopes_updated": "Enabled features updated",
  "linked_client.token_rotated": "Link token rotated",
  "linked_client.unlinked": "Device unlinked itself",
  "store.publish_rejected": "Store publish rejected by moderation",
  "store.image_added": "Image added to a store scene",
  "store.image_removed": "Image removed from a store scene",
  "store.publisher_banned": "Banned from store publishing",
  "store.publisher_unbanned": "Store publishing ban lifted",
  "store.report_resolved": "Store scene report resolved",
  "store.scene_deleted": "Store scene deleted",
  "store.scene_reported": "Store scene reported",
  "store.scene_featured": "Store scene featured",
  "store.scene_content_edited": "Scene contents edited on the web",
  "store.scene_published": "Scene published to the store",
  "store.scene_pulled": "Store scene pulled by moderation",
  "store.scene_restored": "Store scene restored by moderation",
  "store.scene_unfeatured": "Store scene unfeatured",
  "store.version_unyanked": "Store scene version republished",
  "store.version_yanked": "Store scene version unpublished",
  "store.visibility_changed": "Store scene visibility changed",
};

export function auditEventLabel(eventType: string) {
  return eventLabels[eventType] ?? eventType;
}

// A short detail string pulled from the event's metadata: enough to tell two
// events of the same type apart without dumping raw JSON at the user.
export function auditEventDetail(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.name === "string") {
    parts.push(record.name);
  }
  // Frame events: what was sent / changed / touched. Paths and names only —
  // never payloads or file contents (the writers do not record them either).
  if (typeof record.event === "string") {
    parts.push(`event ${record.event}`);
  } else if (typeof record.type === "string") {
    parts.push(record.type.replace(/_/g, " "));
  }
  if (typeof record.from === "string" || typeof record.to === "string") {
    parts.push(`${stringOr(record.from, "—")} → ${stringOr(record.to, "—")}`);
  }
  if (typeof record.path === "string") {
    parts.push(record.path);
  }
  if (typeof record.src === "string" && typeof record.dst === "string") {
    parts.push(`${record.src} → ${record.dst}`);
  }
  if (typeof record.frameosVersion === "string") {
    parts.push(`FrameOS ${record.frameosVersion}`);
  }
  if (Array.isArray(record.keys)) {
    const keys = record.keys.filter((k): k is string => typeof k === "string");
    if (keys.length > 0) {
      parts.push(keys.join(", "));
    }
  }
  if (Array.isArray(record.sceneNames) && record.sceneNames.length > 0) {
    parts.push(
      record.sceneNames.filter((s) => typeof s === "string").join(", "),
    );
  } else if (typeof record.sceneCount === "number") {
    parts.push(
      `${record.sceneCount} scene${record.sceneCount === 1 ? "" : "s"}`,
    );
  }
  if (typeof record.events === "number") {
    parts.push(
      `${record.events} event${record.events === 1 ? "" : "s"}` +
        (record.disabled === true ? " (disabled)" : ""),
    );
  }
  if (typeof record.enabled === "boolean") {
    parts.push(record.enabled ? "enabled" : "disabled");
  }
  if (typeof record.uploaded === "number") {
    parts.push(
      `${record.uploaded} uploaded` +
        (typeof record.skipped === "number"
          ? `, ${record.skipped} skipped`
          : "") +
        (typeof record.failed === "number" && record.failed > 0
          ? `, ${record.failed} failed`
          : ""),
    );
  }
  if (typeof record.freed === "number") {
    parts.push(`${record.freed} freed`);
  }
  if (typeof record.via === "string") {
    parts.push(`via ${record.via.replace(/_/g, " ")}`);
  }
  if (typeof record.method === "string") {
    parts.push(record.method.replace(/_/g, " "));
  }
  if (typeof record.kind === "string") {
    parts.push(record.kind);
  }
  if (typeof record.itemKey === "string") {
    parts.push(record.itemKey);
  }
  if (typeof record.version === "number") {
    parts.push(`v${record.version}`);
  }
  if (typeof record.visibility === "string") {
    parts.push(record.visibility);
  }
  if (typeof record.reason === "string" && record.reason) {
    parts.push(record.reason);
  }
  if (Array.isArray(record.scopes)) {
    parts.push(record.scopes.filter((s) => typeof s === "string").join(", "));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

// The actor column as the activity feeds render it: who did it, reduced to
// account / device / system, plus the IP the write helper stamped on it. The
// raw actor keeps providerSubject, claim token ids and the like, which are
// for forensics, not for display.
export type AuditActorSummary = {
  kind: "account" | "device" | "system";
  accountId?: string;
  ip?: string;
};

export function summarizeAuditActor(actor: unknown): AuditActorSummary {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    return { kind: "system" };
  }
  const record = actor as Record<string, unknown>;
  const ip = typeof record.ip === "string" ? record.ip : undefined;
  if (typeof record.accountId === "string") {
    return {
      kind: "account",
      accountId: record.accountId,
      ...(ip ? { ip } : {}),
    };
  }
  if (record.kind === "device" || record.kind === "frame_enrollment") {
    return { kind: "device", ...(ip ? { ip } : {}) };
  }
  return { kind: "system", ...(ip ? { ip } : {}) };
}

// The frame / scene a row is about, read from the target the writer stamped
// (frame-hub lifecycle rows and every frame route use `target.frameId`; the
// scene routes use `target.sceneId`). The activity feed resolves these to
// names so "Frame disconnected" says which frame.
export type AuditTargetRef = { frameId?: string; sceneId?: string };

export function auditEventTarget(target: unknown): AuditTargetRef {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return {};
  }
  const record = target as Record<string, unknown>;
  return {
    ...(typeof record.frameId === "string" ? { frameId: record.frameId } : {}),
    ...(typeof record.sceneId === "string" ? { sceneId: record.sceneId } : {}),
  };
}
