import { assetUrl } from "../../utils/assetUrl";

// The frameos-wasm preview worker (frameos.js and frameos.wasm sit next to
// it). Root-absolute on the store's own pages, but the SPA can run under a
// prefix: a backend behind Home Assistant ingress serves it at
// /api/hassio_ingress/<token>/frameos-wasm/, the cloud's frames SPA at
// /frames-app/frameos-wasm/. A bare "/frameos-wasm/..." there asks Home
// Assistant itself for the file, and the preview says "FrameOS preview
// worker failed to load". Read at the call, after FRAMEOS_APP_CONFIG is set.
export const PREVIEW_WORKER_PATH = "/frameos-wasm/preview-worker.js";

export function previewWorkerUrl(): string {
  return assetUrl(PREVIEW_WORKER_PATH);
}
