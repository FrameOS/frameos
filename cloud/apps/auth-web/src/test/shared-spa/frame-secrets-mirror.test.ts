import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_PATHS, restoreDeployedSecrets } from "../../../../../../frontend/src/utils/frameSecrets";

// The frontend's secret-path list is a hand-copied mirror of the backend's
// (backend/app/utils/frame_secrets.py). When the backend gained the two
// network passwords (PR #460) the mirror did not, so the deploy baseline
// (fingerprints only) never equalled the live row and "Network settings"
// stayed pending after every fast deploy. This reads the backend list out
// of the Python source so the two cannot drift apart again.
const backendSource = readFileSync(
  resolve(__dirname, "../../../../../../backend/app/utils/frame_secrets.py"),
  "utf8",
);

function tupleBlock(name: string): string[][] {
  // TOP_LEVEL_SECRET_KEYS is one line of strings; NESTED_SECRET_PATHS is a
  // block of one tuple per line, closed by ")" at the start of a line.
  const match = backendSource.match(new RegExp(`${name} = \\(([^\\n]*|[\\s\\S]*?\\n)\\)`));
  if (!match?.[1]) {
    throw new Error(`${name} not found in frame_secrets.py`);
  }
  const body = match[1].replace(/#[^\n]*/g, "");
  const tuples = [...body.matchAll(/\(([^()]*)\)/g)].map((m) =>
    [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((q) => q[1] ?? ""),
  );
  if (tuples.length > 0) {
    return tuples;
  }
  return [...body.matchAll(/"([^"]+)"/g)].map((q) => [q[1] ?? ""]);
}

describe("frameSecrets mirrors the backend secret paths", () => {
  it("lists every top-level and nested secret path the backend fingerprints", () => {
    const backend = [...tupleBlock("TOP_LEVEL_SECRET_KEYS"), ...tupleBlock("NESTED_SECRET_PATHS")]
      .map((path) => path.join("."))
      .sort();
    const frontend = SECRET_PATHS.map((path) => path.join(".")).sort();
    expect(frontend).toEqual(backend);
  });

  it("fills an unchanged Wi-Fi password back into the baseline so network compares equal", () => {
    const baseline = {
      network: { wifiSSID: "home", wifiHotspotPassword: undefined },
      secret_fingerprints: { "network.wifiPassword": "fp-1" },
    };
    const frame = {
      network: { wifiSSID: "home", wifiPassword: "hunter2" },
      secret_fingerprints: { "network.wifiPassword": "fp-1" },
    };
    const restored = restoreDeployedSecrets(baseline as never, frame as never) as {
      network?: Record<string, unknown>;
    };
    expect(restored.network?.wifiPassword).toBe("hunter2");
  });
});
