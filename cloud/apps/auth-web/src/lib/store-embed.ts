// The store's embed mode: `/s/<slug>?embed=1` is a public scene's workspace
// alone (Editor and Preview), framed by frameos.net's front page so a visitor
// can change a scene's code and watch it render, without leaving the page.
// next.config.ts lets the pages below frame it, and nothing else; every other
// page of the store keeps `frame-ancestors 'none'`.
import { previewDeviceFor } from "./preview-devices";

/** The pages allowed to frame an embed: CSP frame-ancestors sources. */
export const storeEmbedAncestors: readonly string[] = ["https://frameos.net", "https://www.frameos.net"];

/** What the embed posts to the page framing it once its scene is loaded,
 * so that page can keep its own stand-in (a screenshot) up until then. */
export const storeEmbedReadyMessage = "frameos-store:embed-ready";

/** The embed's query, as the page receives it. */
export type StoreEmbedQuery = {
  embed?: string | string[] | undefined;
  file?: string | string[] | undefined;
  device?: string | string[] | undefined;
  memory?: string | string[] | undefined;
};

/** What an embed opens on: an app file (`app.tsx`), the preview's Device menu
 * entry (`sensecap-indicator`) and its Memory limit board (`esp32`). */
export type StoreEmbedRequest = {
  file?: string;
  device?: string;
  memory?: string;
};

/** The embed a scene page's query asks for; null for a normal page. A value
 * that is not a plain file name or a known device is dropped, never echoed
 * into the page. */
export function storeEmbedFor(query: StoreEmbedQuery): StoreEmbedRequest | null {
  if (single(query.embed) !== "1") {
    return null;
  }
  const request: StoreEmbedRequest = {};
  const file = single(query.file);
  if (file && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file)) {
    request.file = file;
  }
  const device = single(query.device);
  if (device && previewDeviceFor(device)) {
    request.device = device;
  }
  // The preview ignores a board it does not know (its own list, from
  // frameos-wasm); here only the shape is checked.
  const memory = single(query.memory);
  if (memory && /^[A-Za-z0-9_]{1,32}$/.test(memory)) {
    request.memory = memory;
  }
  return request;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
