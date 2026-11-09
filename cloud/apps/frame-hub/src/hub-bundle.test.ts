import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

// The hub uploads every frame's pictures through the global fetch. npm undici,
// loaded before the process's first fetch, becomes the dispatcher behind it,
// and from 2026-11-07 to 11-09 that refused each upload of a new picture
// ("fetch failed"). ssrf.ts is the module that loads undici; nothing the hub
// imports may reach it. Asked of the bundle, as package.json builds it, since
// in a test the order of those two first uses is not the production one.
it("does not carry npm undici", { timeout: 60_000 }, async () => {
  const { metafile } = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    external: ["bufferutil", "utf-8-validate"],
    format: "cjs",
    logLevel: "silent",
    metafile: true,
    platform: "node",
    target: "node22",
    write: false,
  });
  expect(Object.keys(metafile.inputs).filter((input) => /[/\\]undici[/\\]/.test(input))).toEqual([]);
});
