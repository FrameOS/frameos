// frameos-scene-convert <scene.json> [--out converted.json] [--openai-key KEY]
//                       [--model gpt-5.5] [--dry-run] [--types ai-context.json]
//
// The same conversion the cloud runs at POST /api/scenes/convert, offline:
// a self-hoster's scene in, a JavaScript scene out, the OpenAI bill on
// their own key (OPENAI_API_KEY or --openai-key). Without a key only the
// deterministic pass runs and the report lists what still needs the model.
//
// Input: one scene object, an array of scenes (scenes.json), or
// {"scenes": [...]} — the output keeps the same shape.

import { readFile, writeFile } from "node:fs/promises";
import { convertScenes, describeReport } from "./convert";
import { DEFAULT_CONVERT_MODEL, openAiModelPort } from "./model";
import { rewrapScenes, unwrapScenes } from "./scenes-shape";

type Args = {
  input?: string;
  out?: string;
  openaiKey?: string;
  model?: string;
  dryRun: boolean;
  types?: string;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--out":
      case "-o":
        args.out = value();
        break;
      case "--openai-key":
        args.openaiKey = value();
        break;
      case "--model":
        args.model = value();
        break;
      case "--types":
        args.types = value();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown option ${arg}`);
        }
        if (args.input) {
          throw new Error("one input file at a time");
        }
        args.input = arg;
    }
  }
  return args;
}

const usage = `usage: frameos-scene-convert <scene.json> [--out converted.json] [--openai-key KEY]
                             [--model ${DEFAULT_CONVERT_MODEL}] [--dry-run] [--types ai-context.json]

  --out         where to write the converted JSON (default: stdout)
  --openai-key  OpenAI key for the model pass (default: $OPENAI_API_KEY);
                without one only the deterministic pass runs
  --model       OpenAI model (default: ${DEFAULT_CONVERT_MODEL})
  --dry-run     deterministic pass only, report what the model would get
  --types       cloud/apps/auth-web/src/generated/ai-context.json, to show the
                model the app sandbox's type declarations
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    process.stderr.write(usage);
    process.exit(args.help ? 0 : 2);
  }
  const raw = await readFile(args.input, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const { scenes, shape } = unwrapScenes(parsed);
  const apiKey = args.dryRun ? undefined : (args.openaiKey ?? process.env.OPENAI_API_KEY?.trim());
  let typeDeclarations: string | undefined;
  if (args.types) {
    const context = JSON.parse(await readFile(args.types, "utf8")) as { jsTypeDeclarations?: string };
    typeDeclarations = context.jsTypeDeclarations;
  }
  if (!apiKey && !args.dryRun) {
    process.stderr.write("no OpenAI key (--openai-key or OPENAI_API_KEY): running the deterministic pass only\n");
  }
  const results = await convertScenes(scenes, {
    ...(apiKey ? { model: openAiModelPort({ apiKey, model: args.model }), modelName: args.model ?? DEFAULT_CONVERT_MODEL } : {}),
    onProgress: (message) => process.stderr.write(`${message}\n`),
    tool: "cli",
    typeDeclarations,
  });
  for (const result of results) {
    process.stderr.write(`\n${result.report.sceneName} (${result.report.sceneId})\n`);
    for (const line of describeReport(result.report)) {
      process.stderr.write(`  ${line}\n`);
    }
  }
  const output = JSON.stringify(rewrapScenes(parsed, results.map((result) => result.scene), shape), null, 2);
  if (args.out) {
    await writeFile(args.out, `${output}\n`);
    process.stderr.write(`\nwrote ${args.out}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
  const leftovers = results.reduce((n, result) => n + result.report.needsModel.length + result.report.needsManualPort.length, 0);
  process.exit(leftovers > 0 ? 1 : 0);
}

const isEntry = process.argv[1] !== undefined && /cli\.(ts|js|mjs)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
