// Monaco model URIs are built from scene-supplied names (node ids, app
// keywords, source file names). Interpolated raw, `monaco.Uri.parse` split a
// `#` or `?` off into a fragment or query, so two files could land on one
// model (2026-09 review). Checked against Monaco's own URI parser.

import { describe, expect, it } from "vitest";
// @ts-expect-error -- Monaco's ESM internals ship no type declarations.
import { URI } from "../../../../../../frontend/node_modules/monaco-editor/esm/vs/base/common/uri.js";
import {
  inmemoryModelPath,
  monacoFilePath,
  monacoPathSegment,
} from "../../../../../../frontend/src/utils/monacoPaths";

type ParsedUri = { path: string; toString(): string };
const parse = (value: string): ParsedUri => URI.parse(value) as ParsedUri;

describe("monaco model paths", () => {
  it("keeps two files that differ after a # on separate models", () => {
    // What the editor used to build: both collapse onto /node-1/a.
    expect(parse("inmemory://app-editor/node-1/a#b.ts").path).toBe(parse("inmemory://app-editor/node-1/a#c.ts").path);

    const first = parse(inmemoryModelPath("app-editor", ["node-1"], "a#b.ts"));
    const second = parse(inmemoryModelPath("app-editor", ["node-1"], "a#c.ts"));
    expect(first.path).toBe("/node-1/a#b.ts");
    expect(second.path).toBe("/node-1/a#c.ts");
    expect(first.toString()).not.toBe(second.toString());
  });

  it("round-trips ? and % in an id", () => {
    const uri = parse(inmemoryModelPath("code-node", [], `${"50%?x"}.tsx`));
    expect(uri.path).toBe("/50%?x.tsx");
  });

  it("keeps the / separators of an app's file paths so relative imports resolve", () => {
    expect(inmemoryModelPath("app-editor", ["node-1"], "lib/util.ts")).toBe("inmemory://app-editor/node-1/lib/util.ts");
    expect(monacoFilePath("lib/a b.ts")).toBe("lib/a%20b.ts");
  });

  it("encodes a keyword that holds a slash as one segment", () => {
    expect(monacoPathSegment("a/b")).toBe("a%2Fb");
    expect(inmemoryModelPath("system-app-editor", ["a/b"], "app.ts")).toBe("inmemory://system-app-editor/a%2Fb/app.ts");
  });
});
