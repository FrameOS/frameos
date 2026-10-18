import { describe, expect, it } from "vitest";
import { countMissingPrimitives, missingPrimitivesOf } from "./missing-primitives";

describe("missing primitives", () => {
  it("names what a manual port is missing, from the converter's and the model's reasons", () => {
    expect(missingPrimitivesOf("source nodes are compiled into the binary; nothing can run them — rebuild this part with nodes")).toEqual(["source_node"]);
    expect(missingPrimitivesOf("The app shells out to exiftool to read EXIF orientation.")).toEqual(["shell", "exif"]);
    expect(missingPrimitivesOf("Uses Floyd-Steinberg dithering on the pixels before drawing.")).toEqual(["dither", "drawing"]);
    expect(missingPrimitivesOf("Needs pixie's typeset to measure the text before wrapping it.")).toEqual(["text_metrics", "drawing"]);
    expect(missingPrimitivesOf("Hashes the URL with blake2b to name its cache file outside the assets folder.")).toEqual(["files", "hashing"]);
    expect(missingPrimitivesOf("Reads frameConfig.debug.")).toEqual(["frame_config"]);
    expect(missingPrimitivesOf("Something nobody anticipated.")).toEqual(["other"]);
  });

  it("does not read the linter feedback in an attempts-exhausted reason as the Nim's needs", () => {
    expect(
      missingPrimitivesOf("the model produced no acceptable port in 3 attempts: no require(): only relative imports; the runtime never resolves Promises"),
    ).toEqual(["attempts_exhausted"]);
  });

  it("counts each primitive a reason names, and only those that occur", () => {
    expect(
      countMissingPrimitives([
        "runs a shell command",
        "reads EXIF via a shell command",
        "the model produced no acceptable expression in 3 attempts: x",
      ]),
    ).toEqual({ attempts_exhausted: 1, exif: 1, shell: 2 });
    expect(countMissingPrimitives([])).toEqual({});
  });
});
