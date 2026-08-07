// Bearer-token authentication for requests made by the DEVICE itself (not a
// browser session): the enrollment access token identifies a linked client of
// kind "frame" holding frame:managed, which resolves to exactly one frames
// row. Mirrors the checks the hub makes on the management WebSocket
// (deviceAuthError in cloud/apps/frame-hub/src/protocol.ts) so the HTTP OTA
// routes and the socket agree on what a valid device credential is.

import type { NextResponse } from "next/server";
import { createDb, frames } from "@frameos-cloud/db";
import { authenticateLinkedClient, linkedClientHasScope } from "./backend-auth";
import { jsonError } from "./device-flow";
import { frameForLinkedClient, frameManagedScope } from "./frames";

type FrameRow = typeof frames.$inferSelect;

/**
 * Resolve a device's `Authorization: Bearer …` header to its enrolled frame.
 * Failure returns the HTTP response to send: 401 when the token proves
 * nothing (missing, unknown, revoked, or no frame behind it), 403 when the
 * token is real but is not a managed frame's.
 */
export async function authenticateFrameDevice(
  db: ReturnType<typeof createDb>,
  authorizationHeader: string | null,
): Promise<{ frame: FrameRow } | { response: NextResponse }> {
  const linkedClient = await authenticateLinkedClient(db, authorizationHeader);
  if (!linkedClient) {
    return { response: jsonError("invalid_link_token", 401) };
  }
  if (
    linkedClient.clientKind !== "frame" ||
    !linkedClientHasScope(linkedClient, frameManagedScope)
  ) {
    return { response: jsonError("insufficient_scope", 403) };
  }
  const frame = await frameForLinkedClient(db, linkedClient.id);
  if (!frame) {
    return { response: jsonError("frame_not_enrolled", 401) };
  }
  if (frame.status === "revoked") {
    // authenticateLinkedClient already refuses revoked clients, but the
    // frame row is the authority on frame state — belt and braces.
    return { response: jsonError("frame_revoked", 401) };
  }
  return { frame };
}
