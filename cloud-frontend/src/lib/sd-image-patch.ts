// In-browser SD image personalization (docs/cloud-frames.md, "Placeholder +
// in-browser personalization"). Release images ship /boot/frameos-cloud.txt as
// an all-comments placeholder of exactly 4096 bytes whose first line is the
// magic `# FRAMEOS-CLOUD-CONFIG-V1`. The browser stream-decompresses the
// generic .img.gz, locates the magic, verifies the placeholder, and replaces
// the region in place with real KEY=value content of the same length — no FAT
// metadata changes, no rebuild, and WiFi credentials never leave the browser.
//
// This module is pure (no DOM, no React) so it can be unit-tested in node.

export const CLOUD_CONFIG_MAGIC = "# FRAMEOS-CLOUD-CONFIG-V1";
export const CLOUD_CONFIG_REGION_SIZE = 4096;

// The magic sits in the FAT boot partition (first ~34 MiB of the image); if it
// has not appeared after this many decompressed bytes, the image predates the
// placeholder and the UI falls back to manual instructions.
export const DEFAULT_SEARCH_LIMIT = 48 * 1024 * 1024;

// `placeholder_invalid` is part of the contract the UI maps, but the streaming
// patcher no longer raises it: a region that fails verification is a decoy
// match, and the scan continues past it (see patchCloudConfig).
export type SdImagePatchErrorCode =
  | "config_too_large"
  | "marker_not_found"
  | "placeholder_invalid"
  | "truncated_image"
  | "value_rejected";

export class SdImagePatchError extends Error {
  readonly code: SdImagePatchErrorCode;

  constructor(code: SdImagePatchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SdImagePatchError";
  }
}

// Values must survive the on-device parser verbatim or not be accepted at
// all. The busybox first-boot reader (backend/app/tasks/setup_json_reset.py,
// handle_cloud_config) strips double quotes and backslashes, trims every line
// with `sed 's/^[[:space:]]*//;s/[[:space:]]*$//'` and then strips the value's
// leading whitespace again — so a WPA password that legally begins or ends
// with a space or tab reaches the frame as a *different* password, and the
// frame silently never joins WiFi. Control characters fare no better: a
// newline splits the line in two, the rest vanish. Every one of those cases is
// rejected loudly rather than silently altered; this function only validates
// and returns the value unchanged.
export function sanitizeConfigValue(value: string, label: string): string {
  if (/["\\]/.test(value)) {
    throw new SdImagePatchError(
      "value_rejected",
      `${label} must not contain double quotes or backslashes — the on-device config parser cannot represent them.`,
    );
  }
  // Checked before the control-character rule so a stray edge tab gets the
  // message that explains it. Space and tab are the printable members of the
  // device's POSIX [[:space:]] trim; the rest are control characters.
  if (/^[ \t]|[ \t]$/.test(value)) {
    throw new SdImagePatchError(
      "value_rejected",
      `${label} must not begin or end with a space or tab — the on-device config parser strips them, so the frame would use a different value.`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SdImagePatchError(
      "value_rejected",
      `${label} must not contain line breaks or control characters — the on-device config parser cannot represent them.`,
    );
  }
  return value;
}

// The Wi-Fi country as the device wants it: two ASCII letters, upper case, or
// "" when absent. With `strict` a value that is present but not a country code
// is rejected loudly (the on-device parser would drop it with only a warning
// in a log nobody reads), so the builder says so before the download.
export function normalizeWifiCountry(value: string | undefined, strict = false): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  if (!/^[A-Za-z]{2}$/.test(trimmed)) {
    if (strict) {
      throw new SdImagePatchError(
        "value_rejected",
        "WiFi country must be a two-letter country code (for example FR or US).",
      );
    }
    return "";
  }
  return trimmed.toUpperCase();
}

export interface CloudConfigInput {
  claimToken: string;
  cloudUrl: string;
  // Display driver personalization (all optional): the release image ships
  // every compiled driver, so the first-boot script only patches frame.json
  // and runs driver-setup. Keys unknown to older images are logged and
  // ignored there, so writing them is always safe.
  device?: string | undefined;
  height?: number | undefined;
  name?: string | undefined;
  rotate?: number | undefined;
  uploadUrl?: string | undefined;
  vcom?: string | undefined;
  width?: number | undefined;
  wifiPassword?: string | undefined;
  wifiSsid?: string | undefined;
  // ISO 3166-1 alpha-2 regulatory domain for the Wi-Fi radio ("FR"). Without
  // it the kernel stays in the world domain, where 2.4 GHz channels 12/13
  // cannot be joined — the classic "connects at home in the US, not in
  // Europe" card. Validated to exactly two letters; upper-cased on write.
  wifiCountry?: string | undefined;
  // Console/SSH root password applied via chpasswd on first boot. Absent =
  // the image's build-time default: passwordless root on the console, SSH
  // password logins disabled. The builder UI only omits it when the user
  // explicitly opts into passwordless root.
  rootPassword?: string | undefined;
  // IANA zone name (Intl's resolvedOptions().timeZone in the builder). The
  // first-boot script forwards it into the enrollment state and the runtime
  // writes it into frame.json, so the frame keeps the clock of the browser
  // that made the card instead of the image's UTC.
  timeZone?: string | undefined;
  // OpenSSH public keys for /root/.ssh/authorized_keys, one `authorized_key=`
  // line each (the first-boot script accepts the key repeatedly). Together
  // with everything else they must fit the 4096-byte region: an ed25519 key
  // is ~100 bytes, an RSA-3072 one ~570.
  sshPublicKeys?: string[] | undefined;
}

// The KEY=value lines of a personalized frameos-cloud.txt, without padding.
export function renderCloudConfigLines(input: CloudConfigInput): string[] {
  const lines = [CLOUD_CONFIG_MAGIC];
  const push = (key: string, raw: string | undefined, label: string) => {
    if (!raw) {
      return;
    }
    const value = sanitizeConfigValue(raw, label);
    if (value) {
      lines.push(`${key}=${value}`);
    }
  };
  push("cloud_url", input.cloudUrl, "Cloud URL");
  push("claim_token", input.claimToken, "Claim code");
  push("name", input.name, "Frame name");
  push("wifi_ssid", input.wifiSsid, "WiFi network name");
  push("wifi_password", input.wifiPassword, "WiFi password");
  push(
    "wifi_country",
    normalizeWifiCountry(input.wifiCountry, true) || undefined,
    "WiFi country",
  );
  push("device", input.device, "Display device");
  // Numbers are validated by the UI; undefined means "leave the image's
  // default alone". The on-device patcher re-validates and refuses to
  // half-apply a display config on a bad value.
  push(
    "width",
    input.width === undefined ? undefined : String(input.width),
    "Display width",
  );
  push(
    "height",
    input.height === undefined ? undefined : String(input.height),
    "Display height",
  );
  push(
    "rotate",
    input.rotate === undefined ? undefined : String(input.rotate),
    "Rotation",
  );
  // vcom stays a string so "-1.48" round-trips exactly as typed.
  push("vcom", input.vcom, "VCOM");
  push("upload_url", input.uploadUrl, "Upload URL");
  push("root_password", input.rootPassword, "Root password");
  push("time_zone", input.timeZone, "Time zone");
  for (const key of input.sshPublicKeys ?? []) {
    push("authorized_key", key.trim(), "SSH public key");
  }
  return lines;
}

// How many of the region's bytes a configuration would use — for the
// builder's live budget readout; never throws on an oversized config.
export function cloudConfigContentLength(input: CloudConfigInput): number {
  return new TextEncoder().encode(renderCloudConfigLines(input).join("\n") + "\n").length;
}

// Render the personalized frameos-cloud.txt region: magic line, KEY=value
// lines, then `#` comment padding to exactly CLOUD_CONFIG_REGION_SIZE bytes.
export function renderCloudConfig(input: CloudConfigInput): Uint8Array {
  const lines = renderCloudConfigLines(input);
  const content = new TextEncoder().encode(lines.join("\n") + "\n");
  if (content.length > CLOUD_CONFIG_REGION_SIZE) {
    throw new SdImagePatchError(
      "config_too_large",
      `Configuration does not fit in the ${CLOUD_CONFIG_REGION_SIZE}-byte placeholder — pick fewer SSH keys, or shorten the frame name or WiFi values.`,
    );
  }
  const region = new Uint8Array(CLOUD_CONFIG_REGION_SIZE);
  region.set(content);
  // Pad with '#' comment lines (64 bytes per line including the newline).
  let offset = content.length;
  while (offset < CLOUD_CONFIG_REGION_SIZE) {
    const lineLength = Math.min(64, CLOUD_CONFIG_REGION_SIZE - offset);
    region.fill(0x23 /* '#' */, offset, offset + lineLength - 1);
    region[offset + lineLength - 1] = 0x0a; // '\n'
    offset += lineLength;
  }
  return region;
}

// A pristine placeholder contains only ASCII `#`-comment lines (blank lines
// tolerated, as on-device parsing tolerates them). Anything else means the
// image does not carry the editable placeholder and must not be patched.
export function verifyPlaceholderRegion(region: Uint8Array): boolean {
  let atLineStart = true;
  for (let index = 0; index < region.length; index++) {
    const byte = region[index]!;
    if (byte === 0x0a /* '\n' */) {
      atLineStart = true;
      continue;
    }
    if (byte === 0x0d /* '\r' */) {
      continue;
    }
    if (byte < 0x20 || byte > 0x7e) {
      return false;
    }
    if (atLineStart && byte !== 0x23 /* '#' */) {
      return false;
    }
    atLineStart = false;
  }
  return true;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

function indexOfSequence(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  const limit = haystack.length - needle.length;
  outer: for (let index = Math.max(0, from); index <= limit; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

// Stream patcher: passes decompressed image chunks through unchanged except
// for the placeholder region, which is verified and replaced by configBytes.
// Memory stays bounded — while searching, only a (magic-1)-byte tail is
// retained between chunks; once the magic is found at most one region
// (4096 bytes) plus the current chunk is buffered; afterwards chunks are
// forwarded untouched.
export async function* patchCloudConfig(
  chunks: AsyncIterable<Uint8Array>,
  configBytes: Uint8Array,
  options: { searchLimit?: number } = {},
): AsyncGenerator<Uint8Array, void, undefined> {
  if (configBytes.length !== CLOUD_CONFIG_REGION_SIZE) {
    throw new SdImagePatchError(
      "config_too_large",
      `Internal error: config region must be exactly ${CLOUD_CONFIG_REGION_SIZE} bytes.`,
    );
  }
  const magic = new TextEncoder().encode(CLOUD_CONFIG_MAGIC);
  const searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const markerNotFound = () =>
    new SdImagePatchError(
      "marker_not_found",
      "The cloud-config placeholder was not found in this image — the release predates in-browser personalization.",
    );

  let pending: Uint8Array = new Uint8Array(0);
  // Decompressed bytes already emitted while searching (start offset of
  // `pending` within the image).
  let scannedBase = 0;
  let searching = true;

  for await (const chunk of chunks) {
    if (!searching) {
      if (chunk.length > 0) {
        yield chunk;
      }
      continue;
    }
    pending = pending.length > 0 ? concat(pending, chunk) : chunk;
    // The magic string is not unique in the image: anything on the boot
    // partition may quote it literally (the on-device parser script, this
    // repo's docs if they are ever copied there), and such a file can easily
    // sit at a LOWER offset than /boot/frameos-cloud.txt itself. A candidate
    // that fails verification therefore means "wrong match", not "wrong
    // image" — step one byte past it and keep scanning. Only an exhausted
    // search reports marker_not_found.
    let cursor = 0;
    for (;;) {
      const index = indexOfSequence(pending, magic, cursor);
      if (index === -1) {
        // Keep a tail so a marker straddling the chunk boundary is still
        // found; everything before it is scanned and can be forwarded.
        const keep = Math.min(pending.length, magic.length - 1);
        const flushLength = pending.length - keep;
        if (flushLength > 0) {
          yield pending.slice(0, flushLength);
          scannedBase += flushLength;
          pending = pending.slice(flushLength);
        }
        break;
      }
      if (pending.length < index + CLOUD_CONFIG_REGION_SIZE) {
        // Candidate found but its region is not fully buffered yet. Forward
        // what precedes it so the buffer stays bounded by one region plus
        // the current chunk, and wait for more input.
        if (index > 0) {
          yield pending.slice(0, index);
          scannedBase += index;
          pending = pending.slice(index);
        }
        break;
      }
      const region = pending.subarray(index, index + CLOUD_CONFIG_REGION_SIZE);
      if (!verifyPlaceholderRegion(region)) {
        cursor = index + 1;
        continue;
      }
      if (index > 0) {
        yield pending.slice(0, index);
        scannedBase += index;
      }
      yield configBytes.slice();
      const rest = pending.slice(index + CLOUD_CONFIG_REGION_SIZE);
      pending = new Uint8Array(0);
      searching = false;
      if (rest.length > 0) {
        yield rest;
      }
      break;
    }
    if (searching && scannedBase >= searchLimit) {
      throw markerNotFound();
    }
  }

  if (searching) {
    // Only a candidate whose region never fully arrived can still be in
    // `pending` here (rejected decoys are flushed as ordinary bytes), so an
    // unresolved match means the download stopped mid-region.
    if (indexOfSequence(pending, magic) !== -1) {
      throw new SdImagePatchError(
        "truncated_image",
        "The image ended before the full cloud-config placeholder — the download appears truncated.",
      );
    }
    throw markerNotFound();
  }
}
