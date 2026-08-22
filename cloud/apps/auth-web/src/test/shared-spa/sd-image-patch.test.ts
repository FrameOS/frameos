// In-browser SD image personalization. The module lives in cloud-frontend/
// (the /frames workspace bundle), which has no test runner of its own, so it
// is exercised from here — the same arrangement as the other shared-spa tests.
import { describe, expect, it } from "vitest";
import {
  CLOUD_CONFIG_MAGIC,
  CLOUD_CONFIG_REGION_SIZE,
  patchCloudConfig,
  renderCloudConfig,
  sanitizeConfigValue,
  SdImagePatchError,
  verifyPlaceholderRegion,
} from "../../../../../../cloud-frontend/src/lib/sd-image-patch";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Build the all-comments placeholder the way release images ship it.
function buildPlaceholder(): Uint8Array {
  const region = new Uint8Array(CLOUD_CONFIG_REGION_SIZE);
  const header = encoder.encode(
    `${CLOUD_CONFIG_MAGIC}\n# Edit this file to enroll the frame.\n# See docs/cloud-frames.md\n`,
  );
  region.set(header);
  let offset = header.length;
  while (offset < CLOUD_CONFIG_REGION_SIZE) {
    const lineLength = Math.min(64, CLOUD_CONFIG_REGION_SIZE - offset);
    region.fill(0x23, offset, offset + lineLength - 1);
    region[offset + lineLength - 1] = 0x0a;
    offset += lineLength;
  }
  return region;
}

function patternBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (index * 31 + seed) & 0xff;
  }
  return bytes;
}

function buildImage(prefixLength: number, suffixLength: number) {
  const prefix = patternBytes(prefixLength, 7);
  const region = buildPlaceholder();
  const suffix = patternBytes(suffixLength, 101);
  const image = new Uint8Array(
    prefix.length + region.length + suffix.length,
  );
  image.set(prefix);
  image.set(region, prefix.length);
  image.set(suffix, prefix.length + region.length);
  return { image, prefix, region, suffix };
}

async function* fromChunks(chunks: Uint8Array[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let previous = 0;
  for (const offset of [...offsets, bytes.length]) {
    chunks.push(bytes.slice(previous, offset));
    previous = offset;
  }
  return chunks;
}

async function collect(
  generator: AsyncGenerator<Uint8Array, void, undefined>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of generator) {
    parts.push(part);
    total += part.length;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

const config = renderCloudConfig({
  claimToken: "FRCT_test123",
  cloudUrl: "https://cloud.example.com",
});

describe("sanitizeConfigValue", () => {
  it("passes representable values through untouched", () => {
    expect(sanitizeConfigValue("Kitchen frame", "Name")).toBe("Kitchen frame");
    expect(sanitizeConfigValue("p a s s", "WiFi password")).toBe("p a s s");
  });

  it("refuses CR/LF and control characters instead of stripping them", () => {
    expect(() => sanitizeConfigValue("Kitchen\r\nframe", "Name")).toThrowError(
      /line breaks or control characters/,
    );
    const withControlChar = `a${String.fromCharCode(1)}b`;
    expect(() => sanitizeConfigValue(withControlChar, "Name")).toThrowError(
      SdImagePatchError,
    );
  });

  // The on-device parser trims each line and then the value's leading
  // whitespace (backend/app/tasks/setup_json_reset.py, handle_cloud_config),
  // so an edge space cannot survive the trip. Trimming it here would hand the
  // frame a WiFi password that quietly never works.
  it("refuses leading or trailing spaces and tabs instead of trimming", () => {
    for (const value of [" hunter2", "hunter2 ", "\thunter2", "hunter2\t"]) {
      expect(() => sanitizeConfigValue(value, "WiFi password")).toThrowError(
        /must not begin or end with a space or tab/,
      );
    }
    try {
      sanitizeConfigValue(" hunter2", "WiFi password");
    } catch (error) {
      expect((error as SdImagePatchError).code).toBe("value_rejected");
    }
  });

  it("refuses double quotes", () => {
    expect(() => sanitizeConfigValue('my "network"', "WiFi network name"))
      .toThrowError(SdImagePatchError);
    try {
      sanitizeConfigValue('a"b', "WiFi network name");
    } catch (error) {
      expect((error as SdImagePatchError).code).toBe("value_rejected");
      expect((error as Error).message).toContain("WiFi network name");
    }
  });

  it("refuses backslashes", () => {
    expect(() => sanitizeConfigValue("pass\\word", "WiFi password"))
      .toThrowError(SdImagePatchError);
  });
});

describe("renderCloudConfig", () => {
  it("renders exactly 4096 bytes starting with the magic line", () => {
    expect(config.length).toBe(CLOUD_CONFIG_REGION_SIZE);
    const text = decoder.decode(config);
    expect(text.startsWith(`${CLOUD_CONFIG_MAGIC}\n`)).toBe(true);
    expect(text).toContain("cloud_url=https://cloud.example.com\n");
    expect(text).toContain("claim_token=FRCT_test123\n");
  });

  it("pads with '#' comment lines only", () => {
    const text = decoder.decode(config);
    const contentEnd = text.indexOf("claim_token=FRCT_test123\n") +
      "claim_token=FRCT_test123\n".length;
    const padding = text.slice(contentEnd);
    expect(padding.length).toBeGreaterThan(0);
    for (const line of padding.split("\n")) {
      expect(/^#*$/.test(line)).toBe(true);
    }
    // Padding region is itself a valid placeholder shape.
    expect(
      verifyPlaceholderRegion(config.subarray(contentEnd)),
    ).toBe(true);
  });

  it("includes optional name and WiFi lines when provided", () => {
    const full = renderCloudConfig({
      claimToken: "FRCT_x",
      cloudUrl: "https://c.example",
      name: "Kitchen frame",
      wifiPassword: "hunter2",
      wifiSsid: "MyNet",
      timeZone: "Europe/Brussels",
    });
    const text = decoder.decode(full);
    expect(text).toContain("name=Kitchen frame\n");
    expect(text).toContain("wifi_ssid=MyNet\n");
    expect(text).toContain("wifi_password=hunter2\n");
    // The first-boot script's key (setup_json_reset.py recognizes time_zone).
    expect(text).toContain("time_zone=Europe/Brussels\n");
    expect(full.length).toBe(CLOUD_CONFIG_REGION_SIZE);
  });

  it("omits empty optional values", () => {
    const text = decoder.decode(config);
    expect(text).not.toContain("name=");
    expect(text).not.toContain("wifi_ssid=");
    expect(text).not.toContain("time_zone=");
  });

  it("rejects quotes in values", () => {
    expect(() =>
      renderCloudConfig({
        claimToken: "FRCT_x",
        cloudUrl: "https://c.example",
        wifiPassword: 'pass"word',
        wifiSsid: "net",
      }),
    ).toThrowError(/double quotes or backslashes/);
  });

  it("rejects configs that do not fit the region", () => {
    expect(() =>
      renderCloudConfig({
        claimToken: "FRCT_x",
        cloudUrl: "https://c.example",
        name: "x".repeat(5000),
      }),
    ).toThrowError(SdImagePatchError);
  });
});

describe("verifyPlaceholderRegion", () => {
  it("accepts the shipped placeholder", () => {
    expect(verifyPlaceholderRegion(buildPlaceholder())).toBe(true);
  });

  it("rejects a region with non-comment lines", () => {
    const bad = buildPlaceholder();
    const text = decoder.decode(bad);
    const lineStart = text.indexOf("\n") + 1;
    bad.set(encoder.encode("cloud_url=x"), lineStart);
    expect(verifyPlaceholderRegion(bad)).toBe(false);
  });

  it("rejects binary bytes", () => {
    const region = buildPlaceholder();
    region[2000] = 0x00;
    expect(verifyPlaceholderRegion(region)).toBe(false);
  });
});

describe("patchCloudConfig", () => {
  async function expectPatched(
    chunks: Uint8Array[],
    layout: ReturnType<typeof buildImage>,
  ) {
    const output = await collect(patchCloudConfig(fromChunks(chunks), config));
    expect(output.length).toBe(layout.image.length);
    expect(output.slice(0, layout.prefix.length)).toEqual(layout.prefix);
    expect(
      output.slice(
        layout.prefix.length,
        layout.prefix.length + CLOUD_CONFIG_REGION_SIZE,
      ),
    ).toEqual(config);
    expect(
      output.slice(layout.prefix.length + CLOUD_CONFIG_REGION_SIZE),
    ).toEqual(layout.suffix);
  }

  it("patches when the whole image arrives in one chunk", async () => {
    const layout = buildImage(1000, 500);
    await expectPatched([layout.image], layout);
  });

  it("patches when the marker starts exactly at a chunk boundary", async () => {
    const layout = buildImage(1024, 700);
    await expectPatched(splitAt(layout.image, [1024, 2048]), layout);
  });

  it("patches when the marker is split across three chunks", async () => {
    const layout = buildImage(1000, 300);
    // Marker occupies [1000, 1025); cut inside it twice.
    await expectPatched(splitAt(layout.image, [1005, 1015]), layout);
  });

  it("patches when the region itself spans many small chunks", async () => {
    const layout = buildImage(200, 200);
    const offsets: number[] = [];
    for (let offset = 64; offset < layout.image.length; offset += 64) {
      offsets.push(offset);
    }
    await expectPatched(splitAt(layout.image, offsets), layout);
  });

  it("keeps looking when the only match fails verification", async () => {
    const layout = buildImage(500, 500);
    // Corrupt a byte inside the placeholder (line start after the magic).
    layout.image[500 + CLOUD_CONFIG_MAGIC.length + 1] = 0x78; // 'x'
    await expect(
      collect(patchCloudConfig(fromChunks([layout.image]), config)),
    ).rejects.toMatchObject({ code: "marker_not_found" });
  });

  // The magic is not unique: any file on the boot partition may quote it
  // (the on-device parser script does), and such a file can sit at a lower
  // image offset than /boot/frameos-cloud.txt. The first match must not win.
  it("skips a decoy match and patches the real placeholder behind it", async () => {
    const decoy = encoder.encode(
      `#!/bin/sh\ncase "$line" in ${CLOUD_CONFIG_MAGIC}) echo ok ;; esac\n`,
    );
    const layout = buildImage(600, 400);
    const image = new Uint8Array(decoy.length + layout.image.length);
    image.set(decoy);
    image.set(layout.image, decoy.length);
    const output = await collect(
      patchCloudConfig(fromChunks([image]), config),
    );

    expect(output.length).toBe(image.length);
    // Everything up to the real placeholder — decoy included — is untouched.
    const regionStart = decoy.length + layout.prefix.length;
    expect(output.slice(0, regionStart)).toEqual(image.slice(0, regionStart));
    expect(
      output.slice(regionStart, regionStart + CLOUD_CONFIG_REGION_SIZE),
    ).toEqual(config);
    expect(output.slice(regionStart + CLOUD_CONFIG_REGION_SIZE)).toEqual(
      layout.suffix,
    );
  });

  it("skips a decoy that straddles chunk boundaries", async () => {
    const decoy = encoder.encode(`x${CLOUD_CONFIG_MAGIC} not a placeholder\n`);
    const layout = buildImage(600, 400);
    const image = new Uint8Array(decoy.length + layout.image.length);
    image.set(decoy);
    image.set(layout.image, decoy.length);
    const offsets: number[] = [];
    for (let offset = 7; offset < image.length; offset += 7) {
      offsets.push(offset);
    }
    const output = await collect(
      patchCloudConfig(fromChunks(splitAt(image, offsets)), config),
    );

    const regionStart = decoy.length + layout.prefix.length;
    expect(output.length).toBe(image.length);
    expect(
      output.slice(regionStart, regionStart + CLOUD_CONFIG_REGION_SIZE),
    ).toEqual(config);
  });

  it("aborts when no marker appears within the search limit", async () => {
    const noise = patternBytes(4096, 3);
    const chunks = Array.from({ length: 10 }, () => noise.slice());
    await expect(
      collect(
        patchCloudConfig(fromChunks(chunks), config, {
          searchLimit: 8192,
        }),
      ),
    ).rejects.toMatchObject({ code: "marker_not_found" });
  });

  it("reports a missing marker when the stream ends", async () => {
    await expect(
      collect(patchCloudConfig(fromChunks([patternBytes(100, 5)]), config)),
    ).rejects.toMatchObject({ code: "marker_not_found" });
  });

  it("reports truncation when the stream ends inside the region", async () => {
    const layout = buildImage(100, 0);
    const truncated = layout.image.slice(0, 100 + 1000);
    await expect(
      collect(patchCloudConfig(fromChunks([truncated]), config)),
    ).rejects.toMatchObject({ code: "truncated_image" });
  });

  it("rejects a config of the wrong size", async () => {
    await expect(
      collect(
        patchCloudConfig(fromChunks([new Uint8Array(10)]), new Uint8Array(10)),
      ),
    ).rejects.toMatchObject({ code: "config_too_large" });
  });
});
