// Entry point for the FrameOS Cloud frame hub service.
// Env: DATABASE_URL (required), FRAME_HUB_PORT (default 3100),
// SESSION_SECRET (browser-socket auth). Optional: FRAMEOS_WASM_DIR (where the
// wasm runtime is, for rendering virtual frames; found next to auth-web by
// default) and FRAMEOS_CLOUD_ENCRYPTION_KEY — the hub compares hashed tokens
// and needs it for one thing only: handing a virtual frame's scenes the
// service keys their owner granted them. Without it they render keyless.
import { existsSync } from "node:fs";
import path from "node:path";
import { setWasmAssetsDir } from "../../auth-web/src/lib/scene-render";
import { getHubPort, loadLocalEnv } from "./env";
import { startFrameHub } from "./hub";
import { errorField, logError, logInfo } from "./log";

// The runtime bundle ships with auth-web (public/frameos-wasm), a sibling of
// this app in the checkout and in a release alike. Resolved from the path the
// process was started with, not from the working directory: a release's
// /opt/frameos-cloud is a symlink, and a hub that outlives a deploy must
// read the runtime of the release it now points at.
function locateWasmRuntime(): string | undefined {
  if (process.env.FRAMEOS_WASM_DIR?.trim()) {
    return undefined;
  }
  const relative = path.join("..", "..", "auth-web", "public", "frameos-wasm");
  const candidates = [
    ...(process.argv[1] ? [path.resolve(path.dirname(process.argv[1]), relative)] : []),
    path.resolve(process.cwd(), "..", "auth-web", "public", "frameos-wasm"),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "frameos.wasm"))) ?? candidates[0];
}

async function main() {
  loadLocalEnv();
  setWasmAssetsDir(locateWasmRuntime());
  if (!process.env.DATABASE_URL) {
    logError("frame_hub.missing_database_url", {
      hint: "Run `pnpm db:setup` from cloud/ or set DATABASE_URL",
    });
    process.exit(1);
  }

  const hub = await startFrameHub({ port: getHubPort() });
  logInfo("frame_hub.listening", { port: hub.port });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo("frame_hub.shutting_down", { signal });
    hub
      .close()
      .then(() => {
        logInfo("frame_hub.stopped", {});
        process.exit(0);
      })
      .catch((error: unknown) => {
        logError("frame_hub.shutdown_failed", { error: errorField(error) });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logError("frame_hub.start_failed", { error: errorField(error) });
  process.exit(1);
});
