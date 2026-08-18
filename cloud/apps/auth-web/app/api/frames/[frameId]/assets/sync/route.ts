import { eq } from "drizzle-orm";
import { frameAssets } from "@frameos-cloud/db";
import { NextRequest } from "next/server";
import {
  catalogueFonts,
  readCatalogueFont,
  type CatalogueFont,
} from "../../../../../../src/lib/fonts";
import {
  assetWriteRequestContext,
  invalidateCachedAssetSubtree,
  maxChunkedAssetUploadBytes,
  queueAssetsListRefresh,
  runAssetWriteCommand,
  uploadAssetBytes,
} from "../../../../../../src/lib/frame-asset-write";

export const runtime = "nodejs";

// Copy the fonts FrameOS ships onto a cloud-managed frame — the cloud half of
// the self-hosted backend's "Sync fonts", landing them in the same place the
// renderer reads ({assets}/fonts/<name>, utils/font.nim).
//
// Why this streams instead of answering once at the end: 61 fonts, each an
// asset_put whose ack the device sends after writing to an SD card, is minutes
// of work. A single request held open that long dies in nginx's read timeout
// long before it finishes, and the user watches a spinner that will never
// resolve. NDJSON — the pattern /api/ai/chat already runs through this same
// proxy — keeps bytes flowing and gives the panel a real per-font progress
// line to show.
//
// One font at a time, deliberately. Queueing all 61 at once would put ~53 MB
// of base64 into frame_commands in one go and hand the device a backlog it
// answers for minutes; waiting for each ack keeps exactly one payload in
// flight and lets a frame that goes away stop the run early. Fonts past the
// single-frame cap (NotoColorEmoji, 10.7 MB — the one people want when emoji
// render as blanks) ride asset_put_chunk through uploadAssetBytes, still one
// chunk in flight at a time.

/** Where fonts live on the device, relative to its assets directory. */
const fontsDirectory = "fonts";

// A frame that has gone away answers nothing; after this many consecutive
// failures the run stops rather than spending 30s per font discovering the
// same thing 61 times.
const consecutiveFailureLimit = 3;

type SyncEvent =
  | { type: "start"; total: number; totalBytes: number; alreadyPresent: number }
  | {
      type: "font";
      file: string;
      index: number;
      total: number;
      status: "uploaded" | "skipped" | "failed";
      reason?: string;
    }
  | {
      type: "done";
      uploaded: number;
      skipped: number;
      failed: number;
      stopped?: string;
    }
  | { type: "error"; error: string };

/**
 * Sizes of the files already in the frame's `fonts/` directory, from the
 * cached listing. Missing or stale cache means an empty map, which only costs
 * a re-push — never a wrong skip.
 */
function presentFontSizes(payload: unknown): Map<string, number> {
  const sizes = new Map<string, number>();
  if (!Array.isArray(payload)) {
    return sizes;
  }
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { path?: unknown; size?: unknown; is_dir?: unknown };
    if (record.is_dir === true || typeof record.path !== "string") {
      continue;
    }
    const prefix = `${fontsDirectory}/`;
    if (!record.path.startsWith(prefix)) {
      continue;
    }
    const file = record.path.slice(prefix.length);
    if (file.includes("/")) {
      continue;
    }
    sizes.set(file, typeof record.size === "number" ? record.size : -1);
  }
  return sizes;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ frameId: string }> },
) {
  const { frameId } = await params;
  const context = await assetWriteRequestContext(request, frameId);
  if (context.response) {
    return context.response;
  }
  const { db, accountId, frame } = context;

  const [listing] = await db
    .select({ payload: frameAssets.payload })
    .from(frameAssets)
    .where(eq(frameAssets.frameId, frame.id))
    .limit(1);
  const present = presentFontSizes(listing?.payload);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: SyncEvent) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          closed = true;
        }
      };

      let uploaded = 0;
      let skipped = 0;
      let failed = 0;
      let consecutiveFailures = 0;
      let stopped: string | undefined;

      const alreadyPresent = catalogueFonts.filter(
        (font) => present.get(font.file) === font.size,
      ).length;
      emit({
        type: "start",
        total: catalogueFonts.length,
        totalBytes: catalogueFonts.reduce((sum, font) => sum + font.size, 0),
        alreadyPresent,
      });

      // The directory the fonts go in. asset_put creates parents, so this is
      // belt-and-braces for an empty card; a refusal is not worth stopping for.
      await runAssetWriteCommand(db, accountId, frame.id, "asset_mkdir", {
        path: fontsDirectory,
      });

      const skip = (font: CatalogueFont, index: number, reason: string) => {
        skipped += 1;
        emit({
          type: "font",
          file: font.file,
          index,
          total: catalogueFonts.length,
          status: "skipped",
          reason,
        });
      };

      for (const [index, font] of catalogueFonts.entries()) {
        if (present.get(font.file) === font.size) {
          skip(font, index, "already on the frame");
          continue;
        }
        if (font.size > maxChunkedAssetUploadBytes) {
          // Nothing bundled is anywhere near this today; say which font and
          // why rather than reporting a generic failure nobody can act on.
          skip(
            font,
            index,
            `too large to push (${(font.size / 1_000_000).toFixed(1)} MB, limit ` +
              `${(maxChunkedAssetUploadBytes / 1_000_000).toFixed(0)} MB)`,
          );
          continue;
        }

        let data: Uint8Array;
        try {
          data = new Uint8Array(await readCatalogueFont(font));
        } catch (error) {
          failed += 1;
          consecutiveFailures += 1;
          emit({
            type: "font",
            file: font.file,
            index,
            total: catalogueFonts.length,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
          if (consecutiveFailures >= consecutiveFailureLimit) {
            stopped = "the server could not read the fonts it ships";
            break;
          }
          continue;
        }

        const result = await uploadAssetBytes(
          db,
          accountId,
          frame,
          `${fontsDirectory}/${font.file}`,
          data,
        );
        if (result.ok) {
          uploaded += 1;
          consecutiveFailures = 0;
          emit({
            type: "font",
            file: font.file,
            index,
            total: catalogueFonts.length,
            status: "uploaded",
          });
          continue;
        }

        failed += 1;
        consecutiveFailures += 1;
        emit({
          type: "font",
          file: font.file,
          index,
          total: catalogueFonts.length,
          status: "failed",
          reason:
            result.error === "chunked_upload_unsupported"
              ? "needs a newer FrameOS on the frame (files over 2.5 MB ride asset_put_chunk) — update the frame, then sync again"
              : result.error,
        });
        if (consecutiveFailures >= consecutiveFailureLimit) {
          stopped =
            result.error === "frame_unreachable"
              ? "the frame stopped answering"
              : `the frame refused ${consecutiveFailures} fonts in a row (${result.error})`;
          break;
        }
      }

      if (uploaded > 0) {
        await invalidateCachedAssetSubtree(db, frame.id, fontsDirectory);
        await queueAssetsListRefresh(db, accountId, frame.id);
      }
      emit({
        type: "done",
        uploaded,
        skipped,
        failed,
        ...(stopped ? { stopped } : {}),
      });
      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // nginx buffers a proxied response by default, which would hold every
      // progress line until the run finished and defeat the point.
      "X-Accel-Buffering": "no",
    },
  });
}
