import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { failure, image, run, text, uuid, type ToolContext } from "../result";
import { resolveSceneSource, sceneSourceSchema } from "./scene-source";

// Cloud-managed frames. Every call here is one of the /api/frames routes;
// the few "compound" tools (remove one scene, install from a URL) are two
// routes back to back and say so in their description. Device-facing work
// is asynchronous on the API — a `command_id` comes back and the frame
// applies it when it next talks to the hub — so the tools return that id
// and point at frame_commands_list.

type FrameSummary = Record<string, unknown> & {
  assigned_checksum?: string | null;
  connected?: boolean;
  frameos_version?: string | null;
  hardware?: { platform?: string } | null;
  id: string;
  last_seen_at?: string | null;
  name: string;
  next_wake_at?: string | null;
  scenes_checksum?: string | null;
  sleep_reason?: string | null;
  status: string;
};

const frameId = uuid().describe("Frame id (uuid) from frames_list.");

function compactFrame(frame: FrameSummary) {
  return {
    connected: frame.connected ?? false,
    frameos_version: frame.frameos_version ?? null,
    id: frame.id,
    in_sync:
      frame.assigned_checksum == null ||
      frame.assigned_checksum === frame.scenes_checksum,
    interval: frame.interval ?? null,
    last_seen_at: frame.last_seen_at ?? null,
    name: frame.name,
    next_wake_at: frame.next_wake_at ?? null,
    platform: frame.hardware?.platform ?? null,
    sleep_reason: frame.sleep_reason ?? null,
    status: frame.status,
    timezone: frame.timezone ?? null,
  };
}

function formBody(fields: Record<string, string | Blob>, filename?: string) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Blob && filename) {
      form.append(key, value, filename);
    } else {
      form.append(key, value);
    }
  }
  return form;
}

export function registerFrameTools(server: McpServer, ctx: ToolContext) {
  const api = ctx.client;

  server.registerTool(
    "frames_list",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the account's cloud-managed frames with their status (pending/active/revoked), whether they are connected right now, last seen / next wake time, platform, firmware version and whether they hold the assigned scenes (in_sync).",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const payload = await api.json<{ frames: FrameSummary[] }>(
          "GET",
          "/api/frames",
        );
        return text({
          frames: payload.frames.map(compactFrame),
          workspace_url: `${ctx.publicOrigin}/frames`,
        });
      }),
  );

  server.registerTool(
    "frame_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "Everything the cloud knows about one frame: settings (interval, rotate, timezone, ESP32 power settings…), schedule, assigned scenes state, hardware, last metrics and last reported state, telemetry/service-settings switches.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () => text(await api.json("GET", `/api/frames/${frame_id}`))),
  );

  server.registerTool(
    "frame_rename",
    {
      annotations: { idempotentHint: true },
      description: "Rename a frame (1–256 characters).",
      inputSchema: { frame_id: frameId, name: z.string().min(1).max(256) },
    },
    async ({ frame_id, name }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}`, { body: { name } })),
      ),
  );

  server.registerTool(
    "frame_delete",
    {
      annotations: { destructiveHint: true },
      description:
        "Permanently delete a frame from the account: revokes its link and removes its logs, metrics, commands and scene assignments. The device itself keeps running whatever it last rendered. Requires confirm=true.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true — this cannot be undone."),
        frame_id: frameId,
      },
    },
    async ({ frame_id }) =>
      run(async () => text(await api.json("DELETE", `/api/frames/${frame_id}`))),
  );

  server.registerTool(
    "frame_revoke",
    {
      annotations: { destructiveHint: true },
      description:
        "Revoke a frame's cloud link without deleting its history. NOTE: this is a sudo-mode action — it needs a fresh browser sign-in and is refused for API tokens (reauth_required). Prefer asking the owner to do it at /account/frames.",
      inputSchema: { confirm: z.literal(true), frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}/revoke`, { body: {} })),
      ),
  );

  server.registerTool(
    "frame_confirm",
    {
      description:
        "Confirm a frame that enrolled with a multi-use claim token and is waiting in `pending` status; makes it active and pushes the provisioning scenes.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}/confirm`, { body: {} })),
      ),
  );

  server.registerTool(
    "frame_claim_token_create",
    {
      description:
        "Mint a claim token for enrolling a new frame (shown once). The token goes into the FrameOS web flasher / SD image builder at /frames → Add frame, or into an existing frame's console with `cloud enroll`. `multi_use` tokens enroll many frames (each lands as `pending` until frame_confirm). `frame_id` re-enrolls an existing frame (single use, 1 h).",
      inputSchema: {
        frame_id: uuid().optional().describe("Re-enroll this existing frame."),
        max_uses: z.number().int().min(1).optional(),
        multi_use: z.boolean().optional(),
        name: z.string().max(256).optional().describe("Name the new frame will get."),
        scene_source_frame_id: z
          .string()
          .uuid()
          .optional()
          .describe("Copy this frame's scenes onto the new one at enrollment."),
        timezone: z.string().max(64).optional().describe("IANA zone for the new frame."),
        ttl_days: z
          .union([z.number().int().min(1).max(365), z.literal("forever")])
          .optional(),
      },
    },
    async (input) =>
      run(async () => {
        const result = await api.json<Record<string, unknown>>(
          "POST",
          "/api/frames/claim-tokens",
          { body: input },
        );
        return text({
          ...result,
          how_to_use: `Open ${ctx.publicOrigin}/frames, choose "Add frame", and paste the claim token when the flasher or SD-image builder asks for it. Frames enrolled with a multi-use token appear as pending; confirm them with frame_confirm.`,
        });
      }),
  );

  server.registerTool(
    "frame_settings_update",
    {
      annotations: { idempotentHint: true },
      description:
        "Push device settings to a frame. Allowed keys: debug, interval (seconds 1–86400), name, rotate (0/90/180/270), scaling_mode (contain/cover/stretch/center), timezone (IANA), flip, error_behavior, control_code, metrics_interval, max_http_response_bytes, save_assets, timezone_updater, palette, device_config, gpio_buttons, and on ESP32 the power keys deep_sleep, deep_sleep_on_battery, wake_check_seconds, battery_pin, battery_divider, battery_enable_pin. Unknown keys or values are refused as a whole (setting_not_allowed); old firmware is refused with settings_need_newer_firmware. Returns a command_id.",
      inputSchema: {
        frame_id: frameId,
        settings: z.record(z.string(), z.unknown()).describe("Only the keys to change."),
      },
    },
    async ({ frame_id, settings }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/settings`, {
            body: { settings },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_scenes_list",
    {
      annotations: { readOnlyHint: true },
      description:
        "The scenes assigned to a frame, in order, with the pinned version (null = follow latest), the store's latest version, and whether the device currently holds this exact set (assigned_checksum vs scenes_checksum).",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () => text(await api.json("GET", `/api/frames/${frame_id}/scenes`))),
  );

  server.registerTool(
    "frame_scenes_set",
    {
      annotations: { idempotentHint: true },
      description:
        "Replace a frame's whole scene list (order = display order, max 20). Omitting a scene removes it; scene_version pins a version (null = follow latest). active_scene_id (a store scene id or runtime scene id) chooses which scene shows after the deploy. Deploys to the device as one set_scenes command.",
      inputSchema: {
        active_scene_id: z.string().max(256).optional(),
        frame_id: frameId,
        scenes: z
          .array(
            z.object({
              scene_id: uuid(),
              scene_version: z.number().int().min(1).nullable().optional(),
            }),
          )
          .max(20),
      },
    },
    async ({ active_scene_id, frame_id, scenes }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/scenes`, {
            body: { scenes, ...(active_scene_id ? { scene_id: active_scene_id } : {}) },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_scene_install",
    {
      description:
        "Add a scene to a frame and deploy it. The scene comes from exactly one of: scene_id (a store scene — public, or one of the account's own — from scenes_list / store_browse), url (a scene page on the store, a scene zip, or a scenes.json), or scenes (raw scene JSON, saved first as a new private scene). Re-installing an already-assigned scene re-pins/re-deploys it. activate=true switches the frame to it right away.",
      inputSchema: {
        activate: z.boolean().optional(),
        frame_id: frameId,
        name: z.string().max(128).optional().describe("Name for a scene created from `scenes`."),
        scene_version: z.number().int().min(1).nullable().optional(),
        ...sceneSourceSchema,
      },
    },
    async ({ activate, frame_id, name, scene_version, ...source }) =>
      run(async () => {
        const resolved = await resolveSceneSource(ctx, { ...source, name });
        if ("error" in resolved) {
          return failure(resolved.error);
        }
        const added = await api.json<Record<string, unknown>>(
          "POST",
          `/api/frames/${frame_id}/scenes/add`,
          {
            body: {
              scene_id: resolved.sceneId,
              ...(scene_version !== undefined ? { scene_version } : {}),
            },
          },
        );
        let activated: Record<string, unknown> | undefined;
        if (activate) {
          activated = await api.json<Record<string, unknown>>(
            "POST",
            `/api/frames/${frame_id}/event/setCurrentScene`,
            { body: { sceneId: resolved.sceneId } },
          );
        }
        return text({
          ...added,
          scene: resolved.summary ?? { id: resolved.sceneId },
          ...(resolved.created ? { created_private_scene: true } : {}),
          ...(activated ? { activate: activated } : {}),
        });
      }),
  );

  server.registerTool(
    "frame_scene_remove",
    {
      annotations: { destructiveHint: true },
      description:
        "Remove one scene from a frame (reads the current list and re-assigns it without that scene, keeping the other pins and the order). The store scene itself is untouched.",
      inputSchema: { frame_id: frameId, scene_id: uuid() },
    },
    async ({ frame_id, scene_id }) =>
      run(async () => {
        const current = await api.json<{
          scenes: { scene_id: string; scene_version: number | null }[];
        }>("GET", `/api/frames/${frame_id}/scenes`);
        const remaining = current.scenes.filter((scene) => scene.scene_id !== scene_id);
        if (remaining.length === current.scenes.length) {
          return failure(`Scene ${scene_id} is not assigned to frame ${frame_id}.`);
        }
        const result = await api.json("POST", `/api/frames/${frame_id}/scenes`, {
          body: {
            scenes: remaining.map((scene) => ({
              scene_id: scene.scene_id,
              scene_version: scene.scene_version,
            })),
          },
        });
        return text({ ...result, remaining: remaining.length, removed: scene_id });
      }),
  );

  server.registerTool(
    "frame_scene_activate",
    {
      description:
        "Switch the frame to a scene now (store scene id or the runtime scene id from the device's scene list). Optional `state` seeds the scene's public fields (max 16 KiB). If the device is out of sync with its assigned scenes, the whole set is re-pushed with this scene active.",
      inputSchema: {
        frame_id: frameId,
        scene_id: z.string().max(256),
        state: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ frame_id, scene_id, state }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/event/setCurrentScene`, {
            body: { sceneId: scene_id, ...(state ? { state } : {}) },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_render",
    {
      description: "Ask the frame to re-render its current scene now.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}/event/render`, { body: {} })),
      ),
  );

  server.registerTool(
    "frame_screenshot",
    {
      annotations: { readOnlyHint: true },
      description:
        "The image currently on the frame's display, as an image. refresh=true asks the device for a fresh capture and waits up to ~25 s (the frame must be online; asleep frames answer when they wake); otherwise the cloud's last cached copy is returned immediately.",
      inputSchema: { frame_id: frameId, refresh: z.boolean().optional() },
    },
    async ({ frame_id, refresh }) =>
      run(async () => {
        const { bytes, contentType } = await api.bytes(
          "GET",
          `/api/frames/${frame_id}/image`,
          { query: { t: refresh ? Date.now() : -1 } },
        );
        return image(bytes, contentType, `Frame ${frame_id} display (${contentType}, ${bytes.length} bytes)`);
      }),
  );

  server.registerTool(
    "frame_scene_preview",
    {
      annotations: { readOnlyHint: true },
      description:
        "The frame's cached preview image for one of its scenes (the device's own render when it has one, else the store cover), by store scene id or runtime scene id.",
      inputSchema: {
        frame_id: frameId,
        scene_id: z.string().max(200),
        thumb: z.boolean().optional(),
      },
    },
    async ({ frame_id, scene_id, thumb }) =>
      run(async () => {
        const { bytes, contentType } = await api.bytes(
          "GET",
          `/api/frames/${frame_id}/scene_images/${encodeURIComponent(scene_id)}`,
          { query: { thumb: thumb ? 1 : undefined } },
        );
        return image(bytes, contentType, `Preview of scene ${scene_id} on frame ${frame_id}`);
      }),
  );

  server.registerTool(
    "frame_logs",
    {
      annotations: { readOnlyHint: true },
      description:
        "Recent log lines from a frame (newest last). `limit` caps the lines returned (default 100, max 1000); `search` keeps only lines containing the text; `after_id` pages forward from a previous newest id. Lines are JSON events from the runtime ({event: …}) or plain text.",
      inputSchema: {
        after_id: z.number().int().min(0).optional(),
        frame_id: frameId,
        limit: z.number().int().min(1).max(1000).optional(),
        search: z.string().max(200).optional(),
      },
    },
    async ({ after_id, frame_id, limit, search }) =>
      run(async () => {
        const payload = await api.json<{
          has_more: boolean;
          logs: { id: number; line: string; timestamp: string; type: string }[];
        }>("GET", `/api/frames/${frame_id}/logs`, { query: { after_id } });
        const needle = search?.toLowerCase();
        const filtered = needle
          ? payload.logs.filter((entry) => entry.line.toLowerCase().includes(needle))
          : payload.logs;
        const lines = filtered.slice(-(limit ?? 100));
        return text({
          has_more: payload.has_more,
          logs: lines.map((entry) => ({
            id: entry.id,
            line: entry.line,
            timestamp: entry.timestamp,
            type: entry.type,
          })),
          matched: filtered.length,
          newest_id: payload.logs.at(-1)?.id ?? null,
          oldest_id: payload.logs[0]?.id ?? null,
          returned: lines.length,
        });
      }),
  );

  server.registerTool(
    "frame_metrics",
    {
      annotations: { readOnlyHint: true },
      description:
        "Metrics samples the frame reported (memory, temperature, battery, uptime…) plus reboot markers. `since` (ISO time) narrows to recent samples; `limit` caps the newest samples returned (default 50).",
      inputSchema: {
        frame_id: frameId,
        limit: z.number().int().min(1).max(1000).optional(),
        since: z.string().optional(),
      },
    },
    async ({ frame_id, limit, since }) =>
      run(async () => {
        const payload = await api.json<{
          metrics: unknown[];
          reboots: unknown[];
        }>(
          "GET",
          since
            ? `/api/frames/${frame_id}/metrics/recent`
            : `/api/frames/${frame_id}/metrics`,
          { query: { since } },
        );
        return text({
          metrics: payload.metrics.slice(-(limit ?? 50)),
          reboots: payload.reboots.slice(-20),
          total_samples: payload.metrics.length,
        });
      }),
  );

  server.registerTool(
    "frame_metrics_request",
    {
      description: "Ask the frame to report a fresh metrics sample now (read it with frame_metrics a moment later).",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}/event/metrics`, { body: {} })),
      ),
  );

  server.registerTool(
    "frame_activity",
    {
      annotations: { readOnlyHint: true },
      description:
        "The audit trail for a frame: enrollments, scene deploys, settings pushes, commands, reboots — who did what, when, from where.",
      inputSchema: {
        before: z.string().optional().describe("Cursor `before` from a previous call."),
        before_id: uuid().optional(),
        frame_id: frameId,
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ before, before_id, frame_id, limit }) =>
      run(async () =>
        text(
          await api.json("GET", `/api/frames/${frame_id}/activity`, {
            query: { before, before_id, limit },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_commands_list",
    {
      annotations: { readOnlyHint: true },
      description:
        "Commands queued for the frame that it has not applied yet (pending) or that were sent and await an ack. Empty means everything was applied.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () => text(await api.json("GET", `/api/frames/${frame_id}/commands`))),
  );

  server.registerTool(
    "frame_command_cancel",
    {
      description: "Cancel a queued command that the frame has not picked up yet.",
      inputSchema: { command_id: uuid(), frame_id: frameId },
    },
    async ({ command_id, frame_id }) =>
      run(async () =>
        text(await api.json("DELETE", `/api/frames/${frame_id}/commands/${command_id}`)),
      ),
  );

  server.registerTool(
    "frame_command_send",
    {
      description:
        "Queue a raw device command. Types: render, get_metrics, reboot, restart_runtime, refresh_service_settings, set_schedule (re-push the stored schedule), set_current_scene (needs scene_id = runtime scene id; prefer frame_scene_activate), notify_update_available (start a signed OTA firmware update).",
      inputSchema: {
        frame_id: frameId,
        scene_id: z.string().max(256).optional(),
        type: z.enum([
          "get_metrics",
          "notify_update_available",
          "reboot",
          "refresh_service_settings",
          "render",
          "restart_runtime",
          "set_current_scene",
          "set_schedule",
        ]),
      },
    },
    async ({ frame_id, scene_id, type }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/command`, {
            body: { type, ...(scene_id ? { scene_id } : {}) },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_reboot",
    {
      description: "Reboot the frame (full device reboot).",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}/reboot`, { body: {} })),
      ),
  );

  server.registerTool(
    "frame_restart",
    {
      description: "Restart the FrameOS runtime on the frame (keeps the device up).",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(await api.json("POST", `/api/frames/${frame_id}/restart`, { body: {} })),
      ),
  );

  server.registerTool(
    "frame_schedule_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "The frame's stored schedule: events with minute, hour, weekday (0 daily, 1–7 Mon–Sun, 8 weekdays, 9 weekends), event name (e.g. setCurrentScene) and payload (e.g. {sceneId}), plus disabled flags.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () => {
        const payload = await api.json<{ frame: { schedule?: unknown; timezone?: unknown } }>(
          "GET",
          `/api/frames/${frame_id}`,
        );
        return text({
          schedule: payload.frame.schedule ?? { events: [] },
          timezone: payload.frame.timezone ?? null,
        });
      }),
  );

  server.registerTool(
    "frame_schedule_set",
    {
      annotations: { idempotentHint: true },
      description:
        "Replace the frame's schedule. Each event: {id, minute 0–59, hour 0–23, weekday? 0–9, event (e.g. \"setCurrentScene\"), payload? (e.g. {\"sceneId\": \"<store scene id>\"}), disabled?}. Max 64 events. Hours are in the frame's local time; utc_offset_minutes overrides the offset used when the device lacks a zone.",
      inputSchema: {
        frame_id: frameId,
        schedule: z.object({
          disabled: z.boolean().optional(),
          events: z
            .array(
              z.object({
                disabled: z.boolean().optional(),
                event: z.string().min(1).max(63),
                hour: z.number().int().min(0).max(23),
                id: z.string().min(1).max(64),
                minute: z.number().int().min(0).max(59),
                payload: z.record(z.string(), z.unknown()).optional(),
                weekday: z.number().int().min(0).max(9).optional(),
              }),
            )
            .max(64),
        }),
        utc_offset_minutes: z.number().int().min(-720).max(840).optional(),
      },
    },
    async ({ frame_id, schedule, utc_offset_minutes }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/schedule`, {
            body: {
              schedule,
              ...(utc_offset_minutes !== undefined
                ? { utcOffsetMinutes: utc_offset_minutes }
                : {}),
            },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_service_settings_enable",
    {
      annotations: { idempotentHint: true },
      description:
        "Allow (or stop allowing) this frame to pull the account's service API keys (OpenAI, Unsplash, Home Assistant, …) that scenes need.",
      inputSchema: { enabled: z.boolean(), frame_id: frameId },
    },
    async ({ enabled, frame_id }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/service-settings/enabled`, {
            body: { enabled },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_telemetry_enable",
    {
      annotations: { idempotentHint: true },
      description:
        "Turn log and metrics shipping from this frame on or off (frames enrolled before August 2026 may need this switched on once). Restarts the runtime so it takes effect now.",
      inputSchema: { enabled: z.boolean(), frame_id: frameId },
    },
    async ({ enabled, frame_id }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/telemetry/enabled`, {
            body: { enabled },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_assets_list",
    {
      annotations: { readOnlyHint: true },
      description:
        "Files on the frame's asset storage (photos, fonts, saved images) with size and mtime. refresh=true asks a connected frame for a fresh listing; otherwise the cached one is returned.",
      inputSchema: { frame_id: frameId, refresh: z.boolean().optional() },
    },
    async ({ frame_id, refresh }) =>
      run(async () =>
        text(
          await api.json("GET", `/api/frames/${frame_id}/assets`, {
            query: { refresh: refresh ? 1 : undefined },
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_asset_get",
    {
      annotations: { readOnlyHint: true },
      description:
        "Fetch a file from the frame (max 8 MiB; waits up to ~25 s for an online frame). Images come back as images, text files as text, anything else as a size/type summary. thumb=true asks for a small thumbnail of an image.",
      inputSchema: {
        frame_id: frameId,
        path: z.string().min(1).max(1024),
        thumb: z.boolean().optional(),
      },
    },
    async ({ frame_id, path, thumb }) =>
      run(async () => {
        const { bytes, contentType } = await api.bytes(
          "GET",
          `/api/frames/${frame_id}/asset`,
          { query: { path, thumb: thumb ? 1 : undefined } },
        );
        if (contentType.startsWith("image/")) {
          return image(bytes, contentType, `${path} (${contentType}, ${bytes.length} bytes)`);
        }
        if (
          contentType.startsWith("text/") ||
          contentType.includes("json") ||
          contentType.includes("xml")
        ) {
          const body = new TextDecoder().decode(bytes.subarray(0, 200_000));
          return text({ content: body, content_type: contentType, path, size: bytes.length });
        }
        return text({ content_type: contentType, path, size: bytes.length });
      }),
  );

  server.registerTool(
    "frame_asset_upload",
    {
      description:
        "Upload a file to the frame's asset storage (directory `path`, defaults to the root). Provide the content as base64 or as text. Large files are chunked by the cloud; the frame must be online (waits up to 30 s for the ack).",
      inputSchema: {
        content_base64: z.string().optional(),
        filename: z.string().min(1).max(255),
        frame_id: frameId,
        path: z.string().max(1024).optional().describe("Target directory on the frame."),
        text: z.string().optional(),
      },
    },
    async ({ content_base64, filename, frame_id, path, text: textContent }) =>
      run(async () => {
        if (!content_base64 && textContent === undefined) {
          return failure("Provide content_base64 or text.");
        }
        const bytes = content_base64
          ? Buffer.from(content_base64, "base64")
          : Buffer.from(textContent ?? "", "utf8");
        const form = formBody(
          {
            file: new Blob([bytes]),
            ...(path ? { path } : {}),
          },
          filename,
        );
        return text(
          await api.json("POST", `/api/frames/${frame_id}/assets/upload`, { raw: form }),
        );
      }),
  );

  server.registerTool(
    "frame_asset_delete",
    {
      annotations: { destructiveHint: true },
      description: "Delete a file or empty directory on the frame.",
      inputSchema: { frame_id: frameId, path: z.string().min(1).max(1024) },
    },
    async ({ frame_id, path }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/assets/delete`, {
            raw: formBody({ path }),
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_asset_mkdir",
    {
      description: "Create a directory on the frame's asset storage.",
      inputSchema: { frame_id: frameId, path: z.string().min(1).max(1024) },
    },
    async ({ frame_id, path }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/assets/mkdir`, {
            raw: formBody({ path }),
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_asset_rename",
    {
      description: "Rename or move a file on the frame.",
      inputSchema: {
        dst: z.string().min(1).max(1024),
        frame_id: frameId,
        src: z.string().min(1).max(1024),
      },
    },
    async ({ dst, frame_id, src }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/assets/rename`, {
            raw: formBody({ dst, src }),
          }),
        ),
      ),
  );

  server.registerTool(
    "frame_assets_sync_fonts",
    {
      description:
        "Push the bundled font catalogue onto the frame's fonts/ folder (skips fonts already there). Streams per-font results; returns the summary when done.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () => {
        const events: Record<string, unknown>[] = [];
        await api.ndjson("POST", `/api/frames/${frame_id}/assets/sync`, {
          body: {},
          onEvent: (event) => events.push(event),
        });
        const done = events.find((event) => event.type === "done");
        const failed = events.filter(
          (event) => event.type === "font" && event.status === "failed",
        );
        return text({ failed, summary: done ?? { type: "incomplete" } });
      }),
  );

  server.registerTool(
    "frame_firmware_info",
    {
      annotations: { readOnlyHint: true },
      description:
        "The latest published FrameOS release and its firmware assets per platform; with frame_id, also that frame's current version so you can tell whether an update is available.",
      inputSchema: { frame_id: uuid().optional() },
    },
    async ({ frame_id }) =>
      run(async () => {
        const release = await api.json<Record<string, unknown>>(
          "GET",
          "/api/frames/firmware",
        );
        if (!frame_id) {
          return text(release);
        }
        const detail = await api.json<{ frame: FrameSummary }>(
          "GET",
          `/api/frames/${frame_id}`,
        );
        return text({
          frame: {
            frameos_version: detail.frame.frameos_version ?? null,
            id: detail.frame.id,
            platform: detail.frame.hardware?.platform ?? null,
          },
          release,
          update_available:
            typeof release.release === "string" &&
            typeof detail.frame.frameos_version === "string" &&
            release.release.replace(/^v/, "") !==
              detail.frame.frameos_version.replace(/^v/, ""),
        });
      }),
  );

  server.registerTool(
    "frame_firmware_update",
    {
      description:
        "Tell the frame a signed firmware update is available; the device downloads and applies it on its own schedule (usually within a minute when online). Same as frame_command_send type=notify_update_available.",
      inputSchema: { frame_id: frameId },
    },
    async ({ frame_id }) =>
      run(async () =>
        text(
          await api.json("POST", `/api/frames/${frame_id}/command`, {
            body: { type: "notify_update_available" },
          }),
        ),
      ),
  );
}
