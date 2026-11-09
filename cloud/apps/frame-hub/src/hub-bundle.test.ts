import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Asked of the bundle, built as package.json builds it, because in a test the
// order of a process's first uses is not the production one: npm undici,
// loaded before the first fetch, becomes the dispatcher behind the global
// fetch, and from 2026-11-07 to 11-09 that refused each upload of a new
// picture ("fetch failed"). ssrf.ts is the module that loads undici.
const hubDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const turboConfig = new URL("../../../../turbo.json", import.meta.url);

let directory: string;
let inputs: string[];
let bundle: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "frameos-hub-bundle-"));
  bundle = join(directory, "index.cjs");
  const { metafile } = await build({
    absWorkingDir: hubDirectory,
    bundle: true,
    entryPoints: ["src/index.ts"],
    external: ["bufferutil", "utf-8-validate"],
    format: "cjs",
    logLevel: "silent",
    metafile: true,
    outfile: bundle,
    platform: "node",
    target: "node22",
  });
  inputs = Object.keys(metafile.inputs);
}, 60_000);

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("the frame hub's bundle", () => {
  it("does not carry npm undici", () => {
    expect(inputs.filter((input) => /[/\\]undici[/\\]/.test(input))).toEqual([]);
  });

  // The hub imports auth-web and frontend files by relative path, which turbo
  // cannot see. A source missing here replays an old pass of these checks
  // (#709 broke the hub's typecheck that way, and blocked the next deploy).
  it.each(["build", "typecheck", "test"])("has every source it imports in the cache key of %s", async (task) => {
    const turbo = JSON.parse(await readFile(turboConfig, "utf8")) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    const covered = (turbo.tasks[`@frameos-cloud/frame-hub#${task}`]?.inputs ?? [])
      .filter((input) => input.endsWith("/**"))
      .map((input) => input.slice(0, -2));
    const uncovered = inputs.filter(
      (input) =>
        !input.startsWith("src/") &&
        !input.includes("node_modules/") &&
        // Workspace packages: turbo follows those by itself.
        !input.startsWith("../../packages/") &&
        !input.startsWith("../../../frameos/wasm/") &&
        !covered.some((prefix) => input.startsWith(prefix)),
    );
    expect(uncovered).toEqual([]);
  });

  it("stores a picture, as deploys ask it to before anything is switched", { timeout: 60_000 }, async () => {
    const objects = new Map<string, Buffer>();
    const requests: string[] = [];
    // The four verbs of the S3 API the driver uses.
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const key = request.url ?? "";
        requests.push(request.method ?? "");
        if (request.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          response.end();
        } else if (request.method === "DELETE") {
          objects.delete(key);
          response.statusCode = 204;
          response.end();
        } else if (objects.has(key)) {
          response.end(objects.get(key));
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      // A non-zero exit rejects, with the check's own log line in the error.
      await promisify(execFile)(process.execPath, [bundle, "check-object-store"], {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "",
          R2_CLOUD_ACCESS_KEY_ID: "key",
          R2_CLOUD_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          R2_CLOUD_SECRET_ACCESS_KEY: "secret",
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    expect(requests).toEqual(["HEAD", "PUT", "GET", "DELETE"]);
    expect(objects.size).toBe(0);
  });
});
