import { sealedBackupFormat } from "../../lib/backups";

// What a backend uploads as a config backup (backend
// app/utils/cloud_backup.py `encrypted_backup_content`): a JSON envelope
// around `FRBE1` ‖ ephemeral key ‖ ciphertext. The suites only need the
// shape the route checks, so the "ciphertext" is the label in the clear
// between zero-filled key and tag — deterministic, so equal labels give equal
// bytes and a test can compare what it uploaded with what it downloads.
export function sealedBackup(label: string): Buffer {
  const sealed = Buffer.concat([
    Buffer.from("FRBE1", "ascii"),
    Buffer.alloc(32),
    Buffer.from(label, "utf8"),
    Buffer.alloc(16),
  ]);
  return Buffer.from(
    JSON.stringify({
      format: sealedBackupFormat,
      key_fingerprint: "test-fingerprint",
      meta: { name: label },
      saved_at: "2026-10-18T00:00:00",
      sealed_base64: sealed.toString("base64"),
    }),
    "utf8",
  );
}

export function sealedBackupBase64(label: string): string {
  return sealedBackup(label).toString("base64");
}
