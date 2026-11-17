// A frame's asset storages (docs/cloud-frames.md "Asset storages",
// docs/cloud-frames-contract.json `assetStorages`). The asset verbs carry an
// optional `storage`: absent is the assets folder (an ESP32's TF card when
// one is mounted, a Linux frame's assets directory); `internal` is an
// ESP32's own flash storage. A device that does not know the field ignores
// it and acts on its assets folder, so the cloud names a storage other than
// the default only when the frame's newest listing reported it, and never
// puts the default on the wire at all (an old command stays byte-identical).

import { desc, eq, sql, type SQL } from "drizzle-orm";
import { frameAssets, frameCommands } from "@frameos-cloud/db";
import { cloudFramesContract } from "./cloud-frames-contract.gen";
import type { FramesDatabase } from "./frames";

export interface AssetStorage {
  id: string;
  name: string;
}

const contract = cloudFramesContract.assetStorages;

export const defaultAssetStorage: string = contract.default;

/** The ids a client may ask for; anything else is `invalid_storage`. */
export const knownAssetStorageIds: readonly string[] = Object.keys(contract.ids);

/** What a listing without `storages` stands for (older firmware, Linux). */
export const defaultAssetStorages: readonly AssetStorage[] = contract.defaultListing.map(
  (storage) => ({ id: storage.id, name: storage.name }),
);

const storageIdPattern = /^[a-z][a-z0-9_]{0,31}$/;
const maxStorages = 8;
const maxStorageNameChars = 64;

/** A storage id as a device or a command payload spells it, or undefined. */
export function parseAssetStorageId(value: unknown): string | undefined {
  return typeof value === "string" && storageIdPattern.test(value) ? value : undefined;
}

/**
 * The `storages` a device sent with its listing, sanitized like the listing
 * itself (it is persisted and replayed to every browser): known shape only,
 * bounded, display names without control characters. Null when the device
 * sent none, or nothing usable — the default listing then stands.
 */
export function parseAssetStorages(value: unknown): AssetStorage[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const storages: AssetStorage[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (storages.length >= maxStorages) {
      break;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = parseAssetStorageId(record.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    let name = "";
    if (typeof record.name === "string") {
      for (const ch of record.name) {
        const code = ch.charCodeAt(0);
        name += code < 0x20 || code === 0x7f ? " " : ch;
      }
      name = name.trim().slice(0, maxStorageNameChars);
    }
    storages.push({ id, name: name || id });
  }
  return storages.length > 0 ? storages : null;
}

/** The storage a queued command acts on (absent = the default). */
export function commandAssetStorage(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return parseAssetStorageId(record.storage) ?? defaultAssetStorage;
}

/** The `storage` key a command payload carries: none for the default. */
export function assetStoragePayload(storage: string): { storage?: string } {
  return storage === defaultAssetStorage ? {} : { storage };
}

/** SQL: this frame_commands row acts on `storage`. */
export function commandAssetStorageIs(storage: string): SQL {
  return sql`coalesce(${frameCommands.payload}->>'storage', ${defaultAssetStorage}) = ${storage}`;
}

/**
 * The storages the frame said it has, from its newest listing of any
 * storage; the default listing when it never said (or never listed).
 */
export async function frameAssetStorages(
  db: FramesDatabase,
  frameId: string,
): Promise<AssetStorage[]> {
  const [row] = await db
    .select({ storages: frameAssets.storages })
    .from(frameAssets)
    .where(eq(frameAssets.frameId, frameId))
    .orderBy(desc(frameAssets.updatedAt))
    .limit(1);
  return parseAssetStorages(row?.storages) ?? [...defaultAssetStorages];
}

export type AssetStorageResolution =
  | { ok: true; storage: string }
  | { ok: false; error: "invalid_storage" | "storage_unavailable"; status: number };

/**
 * The `storage` query parameter of an asset route, checked: absent or empty
 * is the default; an id the contract does not know is `invalid_storage`;
 * a non-default id the frame's newest listing did not report is
 * `storage_unavailable` — a frame that does not know the field would act on
 * its assets folder instead.
 */
export async function resolveAssetStorage(
  db: FramesDatabase,
  frameId: string,
  raw: string | null | undefined,
): Promise<AssetStorageResolution> {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, storage: defaultAssetStorage };
  }
  if (!knownAssetStorageIds.includes(raw)) {
    return { ok: false, error: "invalid_storage", status: 400 };
  }
  if (raw === defaultAssetStorage) {
    return { ok: true, storage: raw };
  }
  const reported = await frameAssetStorages(db, frameId);
  if (!reported.some((storage) => storage.id === raw)) {
    // 400 like the self-hosted backend's routes: the request names a place
    // this frame does not have.
    return { ok: false, error: "storage_unavailable", status: 400 };
  }
  return { ok: true, storage: raw };
}
