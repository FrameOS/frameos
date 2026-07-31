import { createHash } from "node:crypto";

// Config backup kinds a linked backend/frame may store, and the consent scope
// each one requires. Asset backups (backup:assets) are a later phase: they are
// client-side encrypted and content-addressed, not simple replace-in-place
// blobs like these. The "templates" kind string predates the templates→scenes
// rename and stays for protocol stability; user-facing labels say "Scene".
export const backupKindScopes: Record<string, string> = {
  frames: "backup:frames",
  templates: "backup:scenes",
};

// Replace-in-place config blobs stay small: a template zip with a preview
// image is well under a megabyte, a frame's metadata + scene JSON smaller
// still. The cap protects the shared database, not a product quota.
export const maxBackupBytes = 8 * 1024 * 1024;
export const maxBackupsPerAccount = 500;

export function backupScopeForKind(kind: unknown): string | undefined {
  return typeof kind === "string" ? backupKindScopes[kind] : undefined;
}

// Account-page display names for backup kinds; the raw kind is the fallback
// so a new kind shows up unstyled instead of not at all.
export const backupKindLabels: Record<string, string> = {
  frames: "Frame",
  templates: "Scene",
};

export function backupKindLabel(kind: string) {
  return backupKindLabels[kind] ?? kind;
}

// Filename for the browser download of a backup blob. Only a conservative
// character set survives so the name is safe inside a Content-Disposition
// header without escaping games.
export function backupDownloadFileName(backup: {
  contentType: string | null;
  itemKey: string;
  kind: string;
  name: string | null;
}) {
  const base = (backup.name || `${backup.kind}-${backup.itemKey}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  const extension =
    backup.contentType === "application/zip"
      ? ".zip"
      : backup.contentType === "application/json"
        ? ".json"
        : ".bin";
  const safeBase = base || "backup";
  return safeBase.toLowerCase().endsWith(extension) ? safeBase : `${safeBase}${extension}`;
}

export function decodeBackupContent(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }

  try {
    const content = Buffer.from(value, "base64");
    // Reject junk that silently decodes to something else.
    if (content.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      return undefined;
    }
    return content;
  } catch {
    return undefined;
  }
}

export function sha256Hex(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

export function backupSummary(row: {
  contentType: string | null;
  createdAt: Date;
  id: string;
  itemKey: string;
  kind: string;
  linkedClientId: string | null;
  name: string | null;
  sha256: string;
  sizeBytes: number;
  updatedAt: Date;
}) {
  return {
    content_type: row.contentType,
    created_at: row.createdAt.toISOString(),
    id: row.id,
    item_key: row.itemKey,
    kind: row.kind,
    linked_client_id: row.linkedClientId,
    name: row.name,
    sha256: row.sha256,
    size_bytes: row.sizeBytes,
    updated_at: row.updatedAt.toISOString(),
  };
}
