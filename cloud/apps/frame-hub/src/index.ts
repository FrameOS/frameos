// Entry point for the FrameOS Cloud frame hub service.
// Env: DATABASE_URL (required), FRAME_HUB_PORT (default 3100),
// SESSION_SECRET (browser-socket auth). FRAMEOS_CLOUD_ENCRYPTION_KEY is not
// needed — the hub only ever sees hashed tokens.
import { getHubPort, loadLocalEnv } from "./env";
import { startFrameHub } from "./hub";
import { errorField, logError, logInfo } from "./log";

async function main() {
  loadLocalEnv();
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
