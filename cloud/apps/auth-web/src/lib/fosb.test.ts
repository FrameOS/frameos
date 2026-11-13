import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  fosbDeltaBlock,
  fosbDeltaRuns,
  fosbFlagDeflate,
  fosbFlagDelta,
  fosbReadsV2,
  fosbV2,
  fosbV2Payload,
  pressMapOf,
} from "./fosb";

// docs/fosb-fixtures.json: the backend writes it by its rule
// (app/utils/server_render.py) and replays it in test_server_rendering.py.
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../../docs/fosb-fixtures.json", import.meta.url)), "utf8"),
) as {
  block: number;
  cases: Array<{
    base: string | null;
    body: string;
    delta: boolean;
    name: string;
    payload: string;
    runs: Array<[number, number]> | null;
    sha256: string;
  }>;
};

/** What the board writes into its panel buffer (fos_fosb_writer_feed). */
function apply(payload: Buffer, basePacked: Buffer, delta: boolean): Buffer {
  if (!delta) {
    return payload;
  }
  const out = Buffer.from(basePacked);
  for (let at = 0; at < payload.length; ) {
    const offset = payload.readUInt32LE(at);
    const length = payload.readUInt32LE(at + 4);
    payload.copy(out, offset, at + 8, at + 8 + length);
    at += 8 + length;
  }
  return out;
}

describe("FOSB version 2 (docs/fosb-fixtures.json)", () => {
  it("compares the blocks the backend compares", () => {
    expect(corpus.block).toBe(fosbDeltaBlock);
  });

  for (const fixture of corpus.cases) {
    it(fixture.name, async () => {
      const body = Buffer.from(fixture.body, "hex");
      const base = fixture.base === null ? null : Buffer.from(fixture.base, "hex");
      if (fixture.runs !== null) {
        expect(fosbDeltaRuns(base!.subarray(12), body.subarray(12))).toEqual(fixture.runs);
      }
      const { delta, payload } = fosbV2Payload(body, base);
      expect(delta).toBe(fixture.delta);
      expect(payload.toString("hex")).toBe(fixture.payload);

      const answer = await fosbV2(body, base);
      expect(answer.subarray(0, 4).toString("latin1")).toBe("FOSB");
      expect(answer[4]).toBe(2);
      expect(answer.subarray(5, 10)).toEqual(body.subarray(5, 10));
      expect(answer.readUInt16LE(10)).toBe(fosbFlagDeflate | (fixture.delta ? fosbFlagDelta : 0));
      expect(answer.subarray(12, 44).toString("hex")).toBe(fixture.sha256);
      const inflated = inflateRawSync(answer.subarray(44));
      expect(inflated.toString("hex")).toBe(fixture.payload);
      const written = apply(inflated, (base ?? body).subarray(12), fixture.delta);
      expect(written).toEqual(body.subarray(12));
      expect(createHash("sha256").update(written).digest("hex")).toBe(fixture.sha256);
    });
  }
});

describe("the version a board reads", () => {
  it("is a number of at least 2", () => {
    expect(fosbReadsV2("2")).toBe(true);
    expect(fosbReadsV2(" 3 ")).toBe(true);
    expect(fosbReadsV2(null)).toBe(false);
    expect(fosbReadsV2("1")).toBe(false);
    expect(fosbReadsV2("yes")).toBe(false);
  });
});

describe("the press map", () => {
  it("goes out as the runtime said it, and nothing else does", () => {
    expect(pressMapOf("10,20,110,70;!0,0,200,100")).toBe("10,20,110,70;!0,0,200,100");
    expect(pressMapOf("")).toBeNull();
    expect(pressMapOf(undefined)).toBeNull();
    expect(pressMapOf("1,2,3,4\r\nX-Injected: 1")).toBeNull();
    expect(pressMapOf("a,b,c,d")).toBeNull();
    expect(pressMapOf("1,".repeat(3000))).toBeNull();
  });
});
