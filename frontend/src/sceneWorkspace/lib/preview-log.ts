// Parsing for the scene preview's log box: the wasm runtime hands the panel
// one string per line. Most are JSON objects with an `event` and a few
// fields ({"event":"render:done","sceneId":"clock","ms":208}); some are
// plain text ('scene "Analog clock face" initialized'); the panel itself
// adds `event: <name> <json>` and `error: <message>` lines. This is the
// cloud-side counterpart of what the frame Logs panel does in the shared
// SPA (frontend/src/scenes/frame/panels/Logs/Logs.tsx).

export type PreviewLogLevel = "info" | "warn" | "error";

export type PreviewLogEntry = {
  id: string;
  /** The ISO time shown in the left column, when known. */
  timestamp?: string | undefined;
  /** The event name shown as a tag, when the line has one. */
  event?: string | undefined;
  /** Everything else, as key/value text pairs in the line's own order. */
  fields: Array<[string, string]>;
  /** The line exactly as received. Shown as-is when there are no fields. */
  raw: string;
  level: PreviewLogLevel;
};

/** A line as the preview panel keeps it: the runtime's text plus the time
 * it arrived (the runtime emits no timestamps of its own). */
export type PreviewLogLine = {
  id: number;
  line: string;
  receivedAt: number;
};

// Keys whose string values read better bare than as JSON string literals.
const bareTextKeys = new Set(["error", "message", "value", "text", "reason"]);

/**
 * Parses one log line. `receivedAt` (epoch ms) stands in for the timestamp
 * when the line carries none of its own.
 */
export function parsePreviewLogLine(
  line: string,
  index: number,
  receivedAt?: number,
): PreviewLogEntry {
  const id = String(index);
  const fallback = receivedAt === undefined ? undefined : new Date(receivedAt).toISOString();
  const trimmed = line.trim();

  const object = parseJsonObject(trimmed);
  if (object) {
    return fromObject(object, id, line, fallback);
  }

  // Lines the panel composes itself: `event: <name> <json>` for scene events
  // and `error: <message>` for runtime errors.
  const composed = /^(event|error):\s*(.*)$/s.exec(trimmed);
  if (composed) {
    const kind = composed[1]!;
    const rest = composed[2]!;
    if (kind === "event") {
      const space = rest.indexOf(" ");
      const name = space === -1 ? rest : rest.slice(0, space);
      const payloadText = space === -1 ? "" : rest.slice(space + 1).trim();
      const payload = payloadText ? parseJsonObject(payloadText) : null;
      const entry = fromObject({ ...(payload ?? {}), event: name }, id, line, fallback);
      // A payload that is not a JSON object is shown as one field, verbatim.
      return payload || !payloadText ? entry : { ...entry, fields: [["payload", payloadText]] };
    }
    return {
      event: "error",
      fields: rest ? [["message", rest]] : [],
      id,
      level: "error",
      raw: line,
      ...(fallback === undefined ? {} : { timestamp: fallback }),
    };
  }

  return {
    fields: [],
    id,
    level: levelFromText(trimmed),
    raw: line,
    ...(fallback === undefined ? {} : { timestamp: fallback }),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fromObject(
  object: Record<string, unknown>,
  id: string,
  raw: string,
  fallbackTimestamp: string | undefined,
): PreviewLogEntry {
  const { event, timestamp, ...rest } = object;
  const fields: Array<[string, string]> = Object.entries(rest).map(([key, value]) => [
    key,
    fieldText(key, value),
  ]);
  const eventName = typeof event === "string" ? event : undefined;
  const own = normalizeTimestamp(timestamp);
  const resolved = own ?? fallbackTimestamp;
  return {
    fields,
    id,
    level: levelFromObject(eventName, rest),
    raw,
    ...(eventName === undefined ? {} : { event: eventName }),
    ...(resolved === undefined ? {} : { timestamp: resolved }),
  };
}

function fieldText(key: string, value: unknown): string {
  if (typeof value === "string" && bareTextKeys.has(key)) {
    return value;
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** ISO strings pass through; epoch seconds or milliseconds become ISO. */
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds until well past the year 5000; anything bigger is ms.
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value)) {
      return normalizeTimestamp(numeric);
    }
    return Number.isNaN(new Date(value).getTime()) ? undefined : value;
  }
  return undefined;
}

const errorPattern = /error|exception|fail|panic|crash/i;
const warnPattern = /warn/i;

function levelFromObject(event: string | undefined, rest: Record<string, unknown>): PreviewLogLevel {
  const level = rest.level ?? rest.severity;
  if (typeof level === "string") {
    const fromKey = levelFromText(level);
    if (fromKey !== "info") {
      return fromKey;
    }
  }
  if (event !== undefined) {
    if (errorPattern.test(event)) {
      return "error";
    }
    if (warnPattern.test(event)) {
      return "warn";
    }
  }
  if ("error" in rest && rest.error !== null && rest.error !== undefined && rest.error !== false) {
    return "error";
  }
  return "info";
}

/** Plain text: the level is whatever the line opens with. */
function levelFromText(text: string): PreviewLogLevel {
  const head = text.slice(0, 40);
  if (/^\W*(error|fatal|exception|panic)\b/i.test(head)) {
    return "error";
  }
  if (/^\W*(warn|warning)\b/i.test(head)) {
    return "warn";
  }
  return "info";
}

/** `YYYY-MM-DD HH:mm:ss` in the viewer's local time; "" when unparseable. */
export function formatLogTimestamp(timestamp: string | number | undefined): string {
  if (timestamp === undefined) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
