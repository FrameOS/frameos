// Lay out scenes with the editor's own auto-arrange, headlessly, and publish
// the arranged scenes as a new version — for the AI-built store scenes that
// were saved without node positions.
//
//   pnpm --filter @frameos-cloud/auth-web ai:realign --all-ai-built [--dry-run] [--force]
//   pnpm --filter @frameos-cloud/auth-web ai:realign --slug analog-clock-face,word-clock
//   pnpm --filter @frameos-cloud/auth-web ai:realign --file scenes.json --out arranged.json
//
// Store scenes are read from the local database (DATABASE_URL) and written
// back through POST /api/account/scenes/{id}/content — the same path the
// editor's "Save as new version" takes — as the eval account (EVAL_ACCOUNT_EMAIL
// / EVAL_ACCOUNT_PASSWORD, defaulting to the dev account). Scenes whose nodes
// all already have positions are skipped unless --force. Needs the cloud dev
// server (CLOUD_URL, default http://localhost:3000) for the editor page.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { arrayContains, asc, eq } from "drizzle-orm";
import { createDb, storeScenes } from "@frameos-cloud/db";
import {
  DEFAULT_CLOUD_URL,
  HeadlessRealigner,
  needsRealign,
  realPosition,
} from "../src/lib/ai/eval/realign";
import { loadStoreSceneBySlug, type Db } from "./lib/store";

type Args = {
  allAiBuilt: boolean;
  slugs: string[];
  file: string | null;
  out: string | null;
  dryRun: boolean;
  force: boolean;
  /** Pause between publishes, so a long list stays under the edit rate limit. */
  delayMs: number;
  timeoutMs: number | null;
};

function usage(): never {
  console.error(
    "usage: tsx evals/realign-scenes.ts (--all-ai-built | --slug a,b | --file scenes.json --out arranged.json) [--dry-run] [--force] [--delay ms] [--timeout ms]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    allAiBuilt: false,
    delayMs: 2_000,
    dryRun: false,
    file: null,
    force: false,
    out: null,
    slugs: [],
    timeoutMs: null,
  };
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
      if (!Number.isFinite(value) || value < 0) {
        usage();
      }
      return value;
    };
    switch (arg) {
      case "--all-ai-built":
        args.allAiBuilt = true;
        break;
      case "--slug":
        args.slugs.push(...takeValue().split(",").map((slug) => slug.trim()).filter(Boolean));
        break;
      case "--file":
        args.file = takeValue();
        break;
      case "--out":
        args.out = takeValue();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--delay":
        args.delayMs = takeNumber();
        break;
      case "--timeout":
        args.timeoutMs = takeNumber();
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        usage();
    }
  }
  const modes = [args.allAiBuilt, args.slugs.length > 0, args.file !== null].filter(Boolean).length;
  if (modes !== 1) {
    usage();
  }
  if (args.file !== null && !args.out && !args.dryRun) {
    usage();
  }
  return args;
}

function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env.local"), resolve(process.cwd(), "../../.env.local")]) {
    if (existsSync(candidate)) {
      try {
        (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.call(process, candidate);
      } catch {
        // tolerate a malformed line
      }
      break;
    }
  }
}

type SceneRecord = { id?: unknown; name?: unknown; nodes?: unknown[] };

function nodeCount(scenes: unknown[]): number {
  return scenes.reduce<number>((sum, scene) => sum + ((scene as SceneRecord)?.nodes?.length ?? 0), 0);
}

function describePosition(node: unknown): string {
  const position = realPosition(node);
  return position ? `(${Math.round(position.x)}, ${Math.round(position.y)})` : "none";
}

/** "a: none → (0, 40); b: none → (300, 40)" for the first few nodes. */
function positionSample(before: unknown[], after: unknown[], count = 3): string {
  const lines: string[] = [];
  for (const [sceneIndex, scene] of before.entries()) {
    const nodes = (scene as SceneRecord)?.nodes ?? [];
    const arranged = ((after[sceneIndex] as SceneRecord)?.nodes ?? []) as unknown[];
    for (const [nodeIndex, node] of nodes.entries()) {
      if (lines.length >= count) {
        break;
      }
      const id = String((node as { id?: unknown })?.id ?? nodeIndex).slice(0, 8);
      lines.push(`${id}: ${describePosition(node)} → ${describePosition(arranged[nodeIndex])}`);
    }
  }
  return lines.join("; ");
}

async function listAiBuiltSlugs(db: Db): Promise<string[]> {
  const rows = await db
    .select({ slug: storeScenes.slug })
    .from(storeScenes)
    .where(arrayContains(storeScenes.tags, ["ai-built"]))
    .orderBy(asc(storeScenes.createdAt));
  return rows.map((row) => row.slug);
}

async function isActive(db: Db, sceneId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: storeScenes.status })
    .from(storeScenes)
    .where(eq(storeScenes.id, sceneId))
    .limit(1);
  return row?.status === "active";
}

type PublishResult = { ok: true; version: number } | { ok: false; error: string };

/** POST the arranged scenes as a new version; waits out the edit rate limit. */
async function publishContent(
  realigner: HeadlessRealigner,
  sceneId: string,
  scenes: unknown[],
): Promise<PublishResult> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${realigner.cloudUrl}/api/account/scenes/${sceneId}/content`, {
      body: JSON.stringify({ scenes }),
      headers: {
        "content-type": "application/json",
        cookie: realigner.cookieHeader,
        origin: realigner.cloudUrl,
      },
      method: "POST",
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      scene?: { version?: number };
    };
    if (response.ok) {
      return { ok: true, version: body.scene?.version ?? -1 };
    }
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after")) || 60;
      console.log(`  rate limited; waiting ${retryAfter}s`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    return { ok: false, error: body.error ?? `HTTP ${response.status}` };
  }
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const cloudUrl = (process.env.CLOUD_URL ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
  const email = process.env.EVAL_ACCOUNT_EMAIL ?? "marius.andra@gmail.com";
  const password = process.env.EVAL_ACCOUNT_PASSWORD ?? "frameos-dev-password";
  const realignOptions = {
    log: (line: string) => console.log(`  ${line}`),
    ...(args.timeoutMs !== null ? { timeoutMs: args.timeoutMs } : {}),
  };

  const realigner = await HeadlessRealigner.launch({ cloudUrl, email, password });
  try {
    if (args.file !== null) {
      const scenes = JSON.parse(await readFile(resolve(args.file), "utf8")) as unknown;
      if (!Array.isArray(scenes)) {
        throw new Error(`${args.file} does not hold a scenes array`);
      }
      const arranged = await realigner.realign(scenes, realignOptions);
      console.log(
        `${args.file}: ${scenes.length} scene(s), ${nodeCount(scenes)} nodes; ${positionSample(scenes, arranged)}`,
      );
      if (args.out) {
        await writeFile(resolve(args.out), JSON.stringify(arranged, null, 2));
        console.log(`wrote ${args.out}`);
      }
      return;
    }

    const databaseUrl = process.env.DATABASE_URL ?? "postgres://frameos_cloud@127.0.0.1:55432/frameos_cloud";
    const db = createDb(databaseUrl);
    const slugs = args.allAiBuilt ? await listAiBuiltSlugs(db) : args.slugs;
    console.log(
      `realign ${slugs.length} store scene(s)${args.dryRun ? " (dry run)" : ""}${args.force ? " (forced)" : ""} via ${cloudUrl}`,
    );
    const summary = { arranged: 0, failed: 0, published: 0, skipped: 0 };
    for (const [index, slug] of slugs.entries()) {
      try {
        const loaded = await loadStoreSceneBySlug(db, slug);
        if (!args.force && !loaded.scenes.some(needsRealign)) {
          summary.skipped += 1;
          console.log(`- ${slug}: all ${nodeCount(loaded.scenes)} nodes already placed, skipped`);
          continue;
        }
        if (!(await isActive(db, loaded.id))) {
          summary.skipped += 1;
          console.log(`- ${slug}: not active, skipped`);
          continue;
        }
        const arranged = await realigner.realign(loaded.scenes, realignOptions);
        const remaining = arranged.filter(needsRealign).length;
        summary.arranged += 1;
        console.log(
          `- ${slug}: ${loaded.scenes.length} scene(s), ${nodeCount(loaded.scenes)} nodes${remaining ? `, ${remaining} scene(s) still unplaced` : ""}; ${positionSample(loaded.scenes, arranged)}`,
        );
        if (args.dryRun) {
          continue;
        }
        const published = await publishContent(realigner, loaded.id, arranged);
        if (!published.ok) {
          summary.failed += 1;
          console.log(`  publish failed: ${published.error}`);
          continue;
        }
        summary.published += 1;
        console.log(`  published as version ${published.version} → ${cloudUrl}/s/${slug}`);
        if (index < slugs.length - 1 && args.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, args.delayMs));
        }
      } catch (error) {
        summary.failed += 1;
        console.log(`- ${slug}: ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(
      `done: ${summary.arranged} arranged, ${summary.published} published, ${summary.skipped} skipped, ${summary.failed} failed`,
    );
  } finally {
    await realigner.close();
  }
}

if (process.argv[1] && /realign-scenes\.ts$/.test(process.argv[1])) {
  main().then(
    // The pooled database client would otherwise keep the process alive.
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
}
