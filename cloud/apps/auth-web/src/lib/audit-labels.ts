// Human-readable rendering of audit_events rows for the account activity
// feed. Unknown event types fall back to the raw type so new events are never
// silently invisible.

const eventLabels: Record<string, string> = {
  "account.email_verified": "Email address verified",
  "account.password_reset": "Password reset completed",
  "account.password_reset_requested": "Password reset requested",
  "account.signed_in": "Signed in",
  "account.signed_up": "Account created",
  "admin.account_deleted": "Account deleted by an admin",
  "admin.sessions_revoked": "Sessions revoked by an admin",
  "backend.inventory_synced": "Backend synced its status",
  "backup.deleted": "Backup deleted",
  "backup.saved": "Backup saved",
  "device_authorization.approved": "Device link approved",
  "device_authorization.denied": "Device link denied",
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
