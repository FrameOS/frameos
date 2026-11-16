// `pnpm dev`'s `playground` pane (mprocs.yaml, cloud/docs/playground.md
// "Working on it"): the cloud's dev server on the wasm runtime built in this
// checkout (FRAMEOS_WASM_SOURCE=local, which the `wasm` pane rebuilds when the
// Nim changes), installed again after every rebuild, with the playground's
// scenes and the frameos-wasm package built again when theirs change. A
// reload of the page shows each. The released runtime the cloud ships is a
// release behind main, so a playground on it cannot show work on the runtime.
//
// Its Scene store browses cloud.frameos.net (FRAMEOS_PLAYGROUND_STORE_URL
// picks another): the runtime asks its page's own origin only through the
// preview proxy, whose guard refuses a loopback address.
//
// It is the cloud's dev server, so it runs instead of the `cloud` pane: Next
// refuses a second dev server in one directory, and both would install their
// runtime into the same public/frameos-wasm.
/* global clearInterval, console, process, setInterval */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localRuntimeDir, readRuntimeStamp, runtimeFilesIn } from "./lib/wasm-runtime.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(dirname(appDir)));
const env = {
  ...process.env,
  FRAMEOS_PLAYGROUND_STORE_URL: process.env.FRAMEOS_PLAYGROUND_STORE_URL ?? "https://cloud.frameos.net",
  FRAMEOS_WASM_SOURCE: "local",
};
const pollMs = 2000;
const say = (line) => console.log(`[playground] ${line}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: appDir, env, stdio: "inherit" });
  return result.status === 0;
}

function runtimeDir() {
  try {
    return localRuntimeDir();
  } catch {
    return null;
  }
}

// Sizes and times of every file under `paths`: a change of any is a new value.
function signature(paths) {
  const parts = [];
  const walk = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name));
      }
    } else {
      parts.push(`${path}:${stat.size}:${stat.mtimeMs}`);
    }
  };
  paths.forEach(walk);
  return parts.join("\n");
}

const runtimePaths = () => {
  const dir = runtimeDir();
  return dir ? runtimeFilesIn(dir).map((file) => join(dir, file)) : [];
};

// Each acted on once its files have stood still for a poll: build_wasm.sh
// writes the bundle's files one after the other.
const watched = [
  {
    paths: runtimePaths,
    act() {
      if (run("node", ["scripts/copy-wasm-assets.mjs"])) {
        const stamp = readRuntimeStamp(runtimeDir());
        say(`runtime ${stamp?.version ?? "?"} (${String(stamp?.commit ?? "?").slice(0, 9)}) installed: reload the page`);
      }
    },
  },
  {
    paths: () => [
      join(repoRoot, "repo", "scenes", "samples"),
      join(repoRoot, "repo", "scenes", "gallery"),
      join(appDir, "playground-scenes"),
    ],
    act() {
      if (run("node", ["scripts/build-playground-scenes.mjs"])) {
        say("scenes built again: reload the page");
      }
    },
  },
  {
    paths: () => [join(repoRoot, "frameos", "wasm", "src")],
    act() {
      if (run("pnpm", ["-w", "exec", "turbo", "run", "build", "--filter=frameos-wasm"])) {
        say("frameos-wasm built again: reload the page");
      }
    },
  },
];

if (!runtimeDir()) {
  say("waiting for the `wasm` pane's first build (frontend/public/frameos-wasm)");
  await new Promise((resolve) => {
    const wait = setInterval(() => {
      if (runtimeDir()) {
        clearInterval(wait);
        resolve();
      }
    }, pollMs);
  });
}

// The package the page drives the runtime with, then everything `dev` does
// first, with this checkout's runtime.
if (!run("pnpm", ["-w", "exec", "turbo", "run", "build", "--filter=frameos-wasm"]) || !run("pnpm", ["run", "predev"])) {
  process.exit(1);
}
for (const entry of watched) {
  entry.seen = signature(entry.paths());
}

const next = spawn("pnpm", ["exec", "next", "dev", "--turbopack"], {
  cwd: appDir,
  env: { ...env, FORCE_COLOR: "1" },
  stdio: ["inherit", "pipe", "inherit"],
});
// Next takes the next free port when 3000 is busy: the address is its own.
let pending = "";
next.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    const local = /Local:.*?(https?:\/\/[\w.-]+(?::\d+)?)/.exec(line);
    if (local) {
      say(`open ${local[1]}/playground`);
    }
  }
});
next.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => next.kill(signal));
}

setInterval(() => {
  for (const entry of watched) {
    const now = signature(entry.paths());
    if (now === entry.seen) {
      entry.changing = null;
    } else if (now === entry.changing) {
      entry.seen = now;
      entry.changing = null;
      entry.act();
    } else {
      entry.changing = now;
    }
  }
}, pollMs);
