import { describe, expect, it } from "vitest";
import { isSealedBackupEnvelope, sealedBackupFormat } from "./backups";

function envelope(fields: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(fields), "utf8");
}

const sealed = Buffer.concat([Buffer.from("FRBE1"), Buffer.alloc(32, 7), Buffer.alloc(40, 9)]);

describe("isSealedBackupEnvelope", () => {
  it("accepts the backend's envelope", () => {
    expect(
      isSealedBackupEnvelope(
        envelope({
          format: sealedBackupFormat,
          key_fingerprint: "AB12-CD34",
          meta: { name: "Kitchen frame" },
          saved_at: "2026-10-18T00:00:00",
          sealed_base64: sealed.toString("base64"),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["plaintext JSON", Buffer.from('{"frame": {}}')],
    ["not JSON", Buffer.from("PK\u0003\u0004 a zip")],
    ["a JSON array", envelope([] as unknown as Record<string, unknown>)],
    [
      "another format",
      envelope({ format: "frameos-frame-backup-v1", key_fingerprint: "fp", sealed_base64: sealed.toString("base64") }),
    ],
    ["no fingerprint", envelope({ format: sealedBackupFormat, sealed_base64: sealed.toString("base64") })],
    [
      "a blob without the magic",
      envelope({ format: sealedBackupFormat, key_fingerprint: "fp", sealed_base64: Buffer.alloc(80).toString("base64") }),
    ],
    [
      "a blob too short for key and tag",
      envelope({ format: sealedBackupFormat, key_fingerprint: "fp", sealed_base64: Buffer.from("FRBE1short").toString("base64") }),
    ],
    ["junk base64", envelope({ format: sealedBackupFormat, key_fingerprint: "fp", sealed_base64: "not!!base64" })],
  ])("refuses %s", (_label, content) => {
    expect(isSealedBackupEnvelope(content)).toBe(false);
  });
});
