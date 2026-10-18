// Why a converted scene still has Nim in it, as a fixed vocabulary the
// `scene_convert` telemetry can aggregate (docs/convergence-todo.md item 5:
// the converter's misses are the roadmap for the loadable catalog). The
// reasons are free text, much of it written by the model, so only the
// category leaves the server, never the sentence: it can quote the scene.
export const missingPrimitives = [
  "source_node",
  "shell",
  "exif",
  "dither",
  "text_metrics",
  "drawing",
  "files",
  "hashing",
  "frame_config",
  "decode_hints",
  "time",
  "attempts_exhausted",
  "other",
] as const;

export type MissingPrimitive = (typeof missingPrimitives)[number];

// Matched against the reason only, case-insensitively. A reason can name
// more than one (the model often writes "shells out to exiftool"), and each
// it names is counted.
const patterns: Array<[Exclude<MissingPrimitive, "attempts_exhausted" | "other">, RegExp]> = [
  ["source_node", /\bsource nodes? (?:are|is) compiled/i],
  ["shell", /\bshell|runShell|subprocess|\bexec(?:ute)?s?\b|command[- ]line|child process/i],
  ["exif", /\bexif/i],
  ["dither", /\bdither/i],
  ["text_metrics", /text (?:metric|measure|width|layout)|measur\w* (?:the )?text|typeset|font metric|glyph|line[- ]?break|word[- ]?wrap/i],
  ["drawing", /\bdraw|pixie|fillPath|strokePath|\bcanvas|\bpixels?\b|blend|composit|\bmask|antialias|raster/i],
  ["files", /\bfiles? (?:outside|system)|filesystem|outside (?:the )?assets|readFile|writeFile|director(?:y|ies)\b/i],
  ["hashing", /blake2|\bsha-?\d|\bhash|crypto/i],
  ["frame_config", /frameConfig|frame config/i],
  ["decode_hints", /decode[- ]target|decode hint/i],
  ["time", /\bchrono\b|times\.now|time ?zone|strftime/i],
];

export function missingPrimitivesOf(reason: string): MissingPrimitive[] {
  // "No acceptable port in N attempts: <lint feedback>": the feedback lists
  // the linter's own rules, not what the Nim needs, so it is not scanned.
  if (/produced no acceptable/i.test(reason)) {
    return ["attempts_exhausted"];
  }
  const found = patterns.filter(([, pattern]) => pattern.test(reason)).map(([name]) => name);
  return found.length > 0 ? found : ["other"];
}

/** Counts per primitive over the reasons, only the primitives that occur. */
export function countMissingPrimitives(reasons: string[]): Partial<Record<MissingPrimitive, number>> {
  const counts: Partial<Record<MissingPrimitive, number>> = {};
  for (const reason of reasons) {
    for (const primitive of missingPrimitivesOf(reason)) {
      counts[primitive] = (counts[primitive] ?? 0) + 1;
    }
  }
  return counts;
}
