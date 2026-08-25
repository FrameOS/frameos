// Render one FrameOS scene headlessly through the cloud dev server and write
// the frame as PNG. Used to eyeball what the AI evals see.
//
//   pnpm --filter @frameos-cloud/auth-web ai:render <store-slug | path/to/scenes.json> \
//     [--out out.png] [--width 800 --height 480] [--scene <sceneId>] [--tz Europe/Brussels]
//
// A store slug resolves through ${CLOUD_URL}/api/store/browse to the scene's
// scenes.json; a path is read as-is. Prints a JSON summary on stdout.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  DEFAULT_CLOUD_URL,
  HeadlessRenderer,
} from "../src/lib/ai/eval/render-check";

type Args = {
  target: string;
  out: string | null;
  width: number;
  height: number;
  sceneId: string | null;
  timeZone: string | null;
  timeoutMs: number | null;
  settleMs: number | null;
};

function usage(): never {
  console.error(
    "usage: tsx evals/render-scene.ts <store-slug | path/to/scenes.json> [--out out.png] [--width 800 --height 480] [--scene id] [--tz zone] [--timeout ms] [--settle ms]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    target: "",
    out: null,
    width: 800,
    height: 480,
    sceneId: null,
    timeZone: null,
    timeoutMs: null,
    settleMs: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const takeValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        usage();
      }
      i += 1;
      return value;
    };
    const takeNumber = (): number => {
      const value = Number(takeValue());
      if (!Number.isFinite(value) || value <= 0) {
        usage();
      }
      return value;
    };
    switch (arg) {
      case "--out":
        args.out = takeValue();
        break;
      case "--width":
        args.width = takeNumber();
        break;
      case "--height":
        args.height = takeNumber();
        break;
      case "--scene":
        args.sceneId = takeValue();
        break;
      case "--tz":
        args.timeZone = takeValue();
        break;
      case "--timeout":
        args.timeoutMs = takeNumber();
        break;
      case "--settle":
        args.settleMs = takeNumber();
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        if (arg.startsWith("--")) {
          usage();
        }
        positional.push(arg);
    }
  }
  const target = positional[0];
  if (!target || positional.length > 1) {
    usage();
  }
  args.target = target;
  return args;
}

type BrowseEntry = { id: string; slug: string };
type BrowsePage = { hasMore: boolean; page: number; scenes: BrowseEntry[] };

async function findStoreScene(
  cloudUrl: string,
  slug: string,
): Promise<BrowseEntry> {
  for (let page = 1; page < 100; page += 1) {
    const response = await fetch(`${cloudUrl}/api/store/browse?page=${page}`);
    if (!response.ok) {
      throw new Error(`browse failed: HTTP ${response.status}`);
    }
    const listing = (await response.json()) as BrowsePage;
    const hit = listing.scenes.find((entry) => entry.slug === slug);
    if (hit) {
      return hit;
    }
    if (!listing.hasMore) {
      break;
    }
  }
  throw new Error(`store scene "${slug}" not found at ${cloudUrl}`);
}

async function loadScenes(
  cloudUrl: string,
  target: string,
): Promise<{ name: string; scenes: unknown[] }> {
  if (target.endsWith(".json") || existsSync(target)) {
    const raw = await readFile(resolve(target), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const scenes = Array.isArray(parsed) ? parsed : [parsed];
    return { name: basename(target, ".json"), scenes };
  }
  const entry = await findStoreScene(cloudUrl, target);
  const response = await fetch(
    `${cloudUrl}/api/store/scenes/${entry.id}/scenes.json`,
  );
  if (!response.ok) {
    throw new Error(`scenes.json failed: HTTP ${response.status}`);
  }
  const parsed: unknown = await response.json();
  const scenes = Array.isArray(parsed) ? parsed : [parsed];
  return { name: target, scenes };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cloudUrl = (process.env.CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
  const { name, scenes } = await loadScenes(cloudUrl, args.target);
  const outPath = resolve(
    args.out ?? `${tmpdir()}/frameos-render-${name.replace(/[^\w.-]+/g, "_")}.png`,
  );

  const renderer = await HeadlessRenderer.launch({ cloudUrl });
  try {
    const result = await renderer.render({
      scenes,
      width: args.width,
      height: args.height,
      ...(args.sceneId ? { sceneId: args.sceneId } : {}),
      ...(args.timeZone ? { timeZone: args.timeZone } : {}),
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.settleMs ? { settleMs: args.settleMs } : {}),
    });
    if (result.png) {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, result.png);
    }
    console.log(
      JSON.stringify(
        {
          rendered: result.rendered,
          renderMs: result.renderMs,
          errorCount: result.errors.length,
          errors: result.errors,
          logCount: result.logs.length,
          width: result.width,
          height: result.height,
          png: result.png ? outPath : null,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.rendered ? 0 : 1;
  } finally {
    await renderer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
