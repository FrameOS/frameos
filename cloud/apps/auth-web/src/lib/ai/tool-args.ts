// Parsing the raw JSON string a model writes as a function call's arguments.
//
// Nothing guarantees that string parses. The Responses API only enforces a
// tool's schema under `strict`, which the scene tools cannot use: their scenes
// are free-form (`items: { type: "object" }`). The way a large call actually
// breaks is a literal newline or tab inside a string — illegal in JSON, and
// exactly what a model writing JS source into an argument tends to emit.
//
// Swallowing that and handing the tool `{}` is worse than useless. The tool
// then reports what an empty payload looks like ("Scene payload must include a
// non-empty scenes array"), the model believes the editor rejected a scene it
// did send, and the turn ends in an apology instead of a retry. So: repair
// what is safely repairable, and otherwise tell the model — in its own tool
// result — that its arguments never parsed and that resending is the fix.

import type { JsonObject } from "./scene-utils";

export type ParsedToolArguments =
  | { args: JsonObject; repaired: boolean }
  | { error: string; detail: string; length: number };

const CONTROL_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Escape raw control characters appearing inside JSON string literals. Those
 * bytes are illegal there in the first place, so anything this rewrites was
 * already unparseable — it can never change the meaning of valid JSON.
 */
export function escapeControlCharsInStrings(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      out += char;
      // A backslash only opens an escape inside a string; outside one it is
      // a syntax error we have no business guessing at.
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && char.length === 1 && char.charCodeAt(0) < 0x20) {
      out +=
        CONTROL_ESCAPES[char] ??
        `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return out;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

// Written at the model, not at us: it has to understand that its own call was
// never executed, that nothing about the content was judged, and that the
// remedy is to send the same call again as valid JSON. Without the last part
// models conclude the tool is broken and tell the user so.
function argumentsError(name: string, length: number, detail: string): string {
  return (
    `The ${name} call did not run: its arguments were not valid JSON (${detail}). ` +
    `${length} characters were received; nothing was parsed, nothing was validated, ` +
    "and nothing reached the editor — so this says nothing about whether the content " +
    "was right. The tool and the editor are working; do not tell the user otherwise. " +
    `Call ${name} again with the same content encoded as valid JSON: escape every ` +
    'newline inside a string as \\n, escape " and \\ inside strings, and make sure the ' +
    "JSON is complete and not cut off. If it is very large, send less per call."
  );
}

/**
 * Parse one function call's arguments. `name` is the tool's name, used only to
 * write an error the model can act on.
 */
export function parseToolArguments(name: string, raw: unknown): ParsedToolArguments {
  const text = typeof raw === "string" ? raw : "";
  // Zero-argument calls (save_scene with no arguments) arrive as "" or "{}".
  if (!text.trim()) {
    return { args: {}, repaired: false };
  }
  let detail: string;
  try {
    const direct = asJsonObject(JSON.parse(text));
    if (direct) {
      return { args: direct, repaired: false };
    }
    detail = "the arguments parsed as JSON but were not an object";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
    const repairedText = escapeControlCharsInStrings(text);
    if (repairedText !== text) {
      try {
        const repaired = asJsonObject(JSON.parse(repairedText));
        if (repaired) {
          return { args: repaired, repaired: true };
        }
      } catch {
        // Not repairable — report the original failure below.
      }
    }
  }
  return { detail, error: argumentsError(name, text.length, detail), length: text.length };
}
