/**
 * FOSB version 2 and the press map: what a render pull's answer carries
 * beyond the picture (docs/server-rendering.md "Only what changed" and "The
 * click"). The backend's port is `app/utils/server_render.py` (fosb_v2,
 * fosb_delta_runs) and `embedded_device.py` (press_map_of);
 * docs/fosb-fixtures.json pins the two to the same deltas.
 */
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { constants as zlibConstants, deflateRaw } from "node:zlib";

const deflateRawAsync = promisify(deflateRaw);

/** The request header a board that reads FOSB version 2 sends. */
export const fosbVersionHeader = "x-frameos-fosb";
export const fosbHeaderLength = 12;
export const fosbV2HeaderLength = 44;
export const fosbFlagDelta = 1;
export const fosbFlagDeflate = 2;
/**
 * What a delta compares: the packed picture in blocks of this many bytes, a
 * run of changed blocks sent whole. Bounded work on any picture, and the
 * unchanged bytes a block carries along cost little once deflated.
 */
export const fosbDeltaBlock = 64;
export const fosbDeflateLevel = 6;

/** Whether a pull's fosbVersionHeader says the board reads version 2. */
export function fosbReadsV2(header: string | null | undefined): boolean {
  if (typeof header !== "string") {
    return false;
  }
  const version = Number.parseInt(header.trim(), 10);
  return Number.isFinite(version) && version >= 2;
}

/**
 * Where `packed` differs from `base` (two packed pictures of one panel), as
 * [offset, length] runs of whole fosbDeltaBlock blocks, the last one cut at
 * the end; adjacent changed blocks make one run.
 */
export function fosbDeltaRuns(base: Uint8Array, packed: Uint8Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  const size = packed.length;
  let start = -1;
  for (let offset = 0; offset < size; offset += fosbDeltaBlock) {
    const end = Math.min(offset + fosbDeltaBlock, size);
    let changed = false;
    for (let i = offset; i < end; i++) {
      if (base[i] !== packed[i]) {
        changed = true;
        break;
      }
    }
    if (changed && start < 0) {
      start = offset;
    } else if (!changed && start >= 0) {
      runs.push([start, offset - start]);
      start = -1;
    }
  }
  if (start >= 0) {
    runs.push([start, size - start]);
  }
  return runs;
}

/**
 * A FOSB version 1 `body` (the 12-byte header, then the packed picture) as
 * the payload version 2 deflates: the picture whole, or, against `base` (the
 * version 1 body of the picture the board shows, the same panel), its
 * changed runs, each a u32le offset, a u32le length and that many bytes.
 * Whole when a delta would not be smaller. Deterministic: the fixtures pin it.
 */
export function fosbV2Payload(body: Uint8Array, base?: Uint8Array | null): { delta: boolean; payload: Buffer } {
  const header = body.subarray(0, fosbHeaderLength);
  const packed = body.subarray(fosbHeaderLength);
  if (base && base.length === body.length && Buffer.compare(base.subarray(0, fosbHeaderLength), header) === 0) {
    const runs = fosbDeltaRuns(base.subarray(fosbHeaderLength), packed);
    const size = runs.reduce((sum, [, length]) => sum + 8 + length, 0);
    if (size < packed.length) {
      const payload = Buffer.alloc(size);
      let at = 0;
      for (const [offset, length] of runs) {
        payload.writeUInt32LE(offset, at);
        payload.writeUInt32LE(length, at + 4);
        payload.set(packed.subarray(offset, offset + length), at + 8);
        at += 8 + length;
      }
      return { delta: true, payload };
    }
  }
  return { delta: false, payload: Buffer.from(packed) };
}

/**
 * The picture as FOSB version 2: the version 1 header with version 2 and its
 * flags, the packed picture's sha256, then the payload (fosbV2Payload), raw
 * deflate. Deflated off the event loop (zlib's thread pool).
 */
export async function fosbV2(body: Uint8Array, base?: Uint8Array | null): Promise<Buffer> {
  const { delta, payload } = fosbV2Payload(body, base);
  const compressed = await deflateRawAsync(payload, { level: fosbDeflateLevel, strategy: zlibConstants.Z_DEFAULT_STRATEGY });
  const header = Buffer.from(body.subarray(0, fosbHeaderLength));
  header[4] = 2;
  header.writeUInt16LE(fosbFlagDeflate | (delta ? fosbFlagDelta : 0), 10);
  const sha = createHash("sha256").update(body.subarray(fosbHeaderLength)).digest();
  return Buffer.concat([header, sha, compressed]);
}

/** The response header a pull's answer carries the press map in. */
export const pressMapHeader = "X-FrameOS-Press";
export const maxPressMapChars = 4096;

/**
 * The press map a render reported (`frameos_wasm_press_map`), as the header
 * carries it: `x0,y0,x1,y1` entries in the panel's pixels, `;` between them,
 * `!` before one where a press is not taken. Null when nothing takes a
 * press, the runtime said nothing, or it is not one.
 */
export function pressMapOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxPressMapChars) {
    return null;
  }
  return /^[0-9,;!]+$/.test(value) ? value : null;
}
