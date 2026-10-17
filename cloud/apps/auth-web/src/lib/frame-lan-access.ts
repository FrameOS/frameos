// Local network access, the frame-level switch: when it is off, scene HTTP on a
// cloud-managed frame may not reach private/local addresses. The device holds the truth (its state file
// on Linux, NVS on an ESP32) and reports it as `hardware.lanAccess` in hello
// and in every `state`; the cloud keeps no column of its own. Turning it ON
// is verified on the device: `lan_access_challenge` draws a six-digit code on
// the panel and `lan_access_set {enabled: true, code}` checks it there.
// Turning it OFF needs no code. Verbs and tokens: docs/cloud-frames-contract.json.
//
// Pure on purpose (no database, no Next request): frames.ts reads
// frameLanAccess for the summary the hub also broadcasts, and the unit tests
// run the body and outcome rules without either.

export const lanAccessChallengeVerb = "lan_access_challenge";
export const lanAccessSetVerb = "lan_access_set";
export type LanAccessVerb = typeof lanAccessChallengeVerb | typeof lanAccessSetVerb;

// The device's challenge lifetime (both runtimes). The ack does not survive
// into frame_commands, so the route reports the contract's number.
export const lanAccessChallengeSeconds = 300;
// Queue lifetimes, measured from the frame's announced wake
// (enqueueFrameCommand): a challenge may wait for a sleeping frame a little
// longer than the code it starts would live; a set is a "now" command.
export const lanAccessChallengeTtlMs = 10 * 60 * 1000;
export const lanAccessSetTtlMs = 5 * 60 * 1000;
// How long a route waits for the device's ack before answering `queued`.
export const lanAccessAckWaitMs = 15_000;
export const lanAccessAckPollMs = 500;

const codePattern = /^\d{6}$/;

/**
 * The frame's reported switch: true/false from the device's hardware report,
 * null when the firmware does not report it (too old to manage it from the
 * cloud) or the report is missing.
 */
export function frameLanAccess(hardware: unknown): boolean | null {
  if (!hardware || typeof hardware !== "object" || Array.isArray(hardware)) {
    return null;
  }
  const value = (hardware as Record<string, unknown>).lanAccess;
  return typeof value === "boolean" ? value : null;
}

export interface LanAccessRefusal {
  status: number;
  error: string;
  detail: string;
}

// What each token means to the person at the screen. Short and plain: the
// SPA shows `detail` inline in the local network access dialog.
const refusals: Record<string, { status: number; detail: string }> = {
  // The device answered unknown_verb / unsupported_verb, or does not report
  // the switch at all.
  unsupported: { detail: "Update this frame's FrameOS first.", status: 409 },
  no_panel: { detail: "This frame has no screen to show a code on.", status: 409 },
  invalid_lan_access: { detail: "Choose whether local network access is on or off.", status: 400 },
  code_required: { detail: "Enter the code showing on the frame.", status: 403 },
  invalid_code: { detail: "That code is not right. Check the frame and try again.", status: 403 },
  code_expired: { detail: "That code has expired. Show a new code on the frame.", status: 403 },
  too_many_attempts: { detail: "Too many wrong codes. Show a new code on the frame.", status: 403 },
  // The device's wrong-code budget (10 an hour) is spent: no new code
  // either, until the hour has passed.
  rate_limited: { detail: "Too many wrong codes in the last hour. Try again later.", status: 429 },
  persist_failed: { detail: "The frame could not save the setting. Try again.", status: 500 },
  // The device could not make a code (no entropy source).
  challenge_failed: { detail: "The frame could not make a code. Try again.", status: 500 },
  timeout: { detail: "The frame did not answer in time. Try again.", status: 504 },
};

const unsupportedDeviceErrors = new Set(["unknown_verb", "unsupported_verb"]);
// A device error outside the table travels as itself when it looks like a
// token, so a new one is still named; anything else is not echoed.
const tokenPattern = /^[a-z][a-z0-9_]{0,63}$/;

export function lanAccessRefusal(
  error: string,
  overrides: { status?: number; detail?: string } = {},
): LanAccessRefusal {
  const known = refusals[error];
  if (known) {
    return { detail: overrides.detail ?? known.detail, error, status: overrides.status ?? known.status };
  }
  return {
    detail: overrides.detail ?? "The frame could not do that right now. Try again.",
    error: tokenPattern.test(error) ? error : "frame_error",
    status: overrides.status ?? 502,
  };
}

export type LanAccessSetPayload = { enabled: false } | { enabled: true; code: string };

/**
 * The body of POST /api/frames/{id}/lan_access: `{enabled: bool, code?}`.
 * The code is checked for shape here, so a typo does not burn one of the
 * device's five attempts; whitespace anywhere is dropped ("123 456"). A code
 * sent with `enabled: false` is not forwarded: turning off needs none.
 */
export function parseLanAccessSetBody(
  body: Record<string, unknown>,
): { ok: true; payload: LanAccessSetPayload } | ({ ok: false } & LanAccessRefusal) {
  if (typeof body.enabled !== "boolean") {
    return { ok: false, ...lanAccessRefusal("invalid_lan_access") };
  }
  if (!body.enabled) {
    return { ok: true, payload: { enabled: false } };
  }
  if (body.code === undefined || body.code === null) {
    return { ok: false, ...lanAccessRefusal("code_required", { status: 400 }) };
  }
  if (typeof body.code !== "string") {
    return {
      ok: false,
      ...lanAccessRefusal("invalid_code", {
        detail: "Enter the 6-digit code showing on the frame.",
        status: 400,
      }),
    };
  }
  const code = body.code.replace(/\s+/g, "");
  if (code === "") {
    return { ok: false, ...lanAccessRefusal("code_required", { status: 400 }) };
  }
  if (!codePattern.test(code)) {
    return {
      ok: false,
      ...lanAccessRefusal("invalid_code", {
        detail: "Enter the 6-digit code showing on the frame.",
        status: 400,
      }),
    };
  }
  return { ok: true, payload: { code, enabled: true } };
}

/** Where a queued command stood when the route stopped waiting for it. */
export type FrameCommandOutcome =
  | { state: "acked" }
  | { state: "failed"; error: string | null }
  | { state: "expired"; error: string | null }
  | { state: "waiting" }
  | { state: "missing" };

/**
 * The HTTP answer for a local network access verb's outcome, as the shared
 * SPA reads it:
 *
 *  - challenge acked: 200 {status: "shown", expires_in_seconds: 300}
 *  - set acked:       200 {status: "applied", lan_access: <enabled>}
 *  - no ack yet:      200 {status: "queued"} (asleep, or slower than the wait;
 *                     the command stays queued for the frame)
 *  - refused:         4xx/5xx {detail, error} with the device's token
 *  - expired:         504 {detail, error: "timeout"} (superseded or cancelled
 *                     while waiting)
 */
export function lanAccessOutcomeResponse(
  verb: LanAccessVerb,
  outcome: FrameCommandOutcome,
  enabled?: boolean,
): { status: number; body: Record<string, unknown> } {
  const refused = (refusal: LanAccessRefusal) => ({
    body: { detail: refusal.detail, error: refusal.error },
    status: refusal.status,
  });
  switch (outcome.state) {
    case "acked":
      return verb === lanAccessChallengeVerb
        ? { body: { expires_in_seconds: lanAccessChallengeSeconds, status: "shown" }, status: 200 }
        : { body: { lan_access: enabled === true, status: "applied" }, status: 200 };
    case "waiting":
      return { body: { status: "queued" }, status: 200 };
    case "failed": {
      const error = outcome.error ?? "error";
      return refused(lanAccessRefusal(unsupportedDeviceErrors.has(error) ? "unsupported" : error));
    }
    case "expired":
      return refused(lanAccessRefusal("timeout"));
    case "missing":
      return { body: { error: "invalid_frame" }, status: 404 };
  }
}
