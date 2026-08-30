// Pass 2's instructions: what the model is told about the two runtimes and
// the mapping between them. The tables here ARE the ones in
// docs/nim-to-js-conversion.md (prompt.test.ts checks every row is in the
// doc), so a mapping is corrected in one place and the prompt follows.

import type { ModelTool } from "./model";

export type Mapping = { nim: string; js: string };

/** Code nodes: what the deterministic pass already handles, restated for the leftovers. */
export const codeNodeMappings: Mapping[] = [
  { js: 'String(state.a?.b ?? "")', nim: 'scene.state{"a"}{"b"}.getStr / $scene.state{…}' },
  { js: 'Number(… ?? 0) / Boolean(…) / String(… ?? "")', nim: ".getInt / .getFloat / .getBool / .getStr" },
  { js: "c ? a : b", nim: "if c: a else: b (expression)" },
  { js: "=== !== && || ! + String(x) .length Math.trunc() Number() % Math.trunc(a/b)", nim: "== != and or not & $x .len .int .float mod div" },
  { js: "now() (code node) / Date.now()/1000 (app)", nim: "epochTime() / now()" },
  { js: "x, x, JSON.parse(x)", nim: "%*x, newJString(x), parseJson(x)" },
  { js: "the String methods (.split .trim .toLowerCase .includes .startsWith; replace → .split(a).join(b))", nim: "x.split(\",\"), x.strip, x.toLowerAscii, x.contains(y), x.startsWith(y), x.replace(a, b)" },
  { js: "parseInt(x, 10), parseFloat(x), Number(x).toFixed(n)", nim: "parseInt(x), parseFloat(x), $x.formatFloat(ffDecimal, n)" },
  { js: 'format(now(), "{hour/2}:{minute/2}") — strftime letters mapped to curly tokens', nim: 'times.now().format("HH:mm") and chrono patterns' },
];

/** Apps: the Nim app surface (frameos/src/frameos/apps.nim, pixie) onto the JS bridge. */
export const appMappings: Mapping[] = [
  { js: "app.config.x, app.log/app.logError/frameos.error", nim: "self.appConfig.x, self.log/logError/error" },
  { js: 'app.state.k / frameos.setState("k", v)', nim: 'self.scene.state{"k"} / self.scene.state["k"] = %*v' },
  { js: "app.frame.width/height/assetsPath/timeZone", nim: "self.frameConfig.renderWidth/renderHeight/assetsPath/timeZone" },
  { js: "context.hasImage, context.imageWidth/imageHeight, frameos.setNextSleep(s)", nim: "context.hasImage, context.image.width/height, context.nextSleep = s" },
  { js: "frameos.httpRequest(url, {method, headers, body, timeoutMs, base64}), frameos.fetchJson/fetchText", nim: "boundedRequestWithHeaders, utils/http_client" },
  { js: "frameos.writeAsset, frameos.readAsset", nim: "self.saveAsset, readFile/writeFile under assets" },
  { js: "a data/downloadImage node wired in / frameos.loadAssetImage", nim: "downloadImage (remote) / (local)" },
  { js: "Math.random() / undefined + ?. / throw new Error / template literal", nim: "rand() / Option[T] / raise newException / strformat" },
  { js: "an SVG string via frameos.svg(): <rect>, <path>, <text> with font-family/font-size, #rrggbb", nim: "pixie newImage, fill, draw, fillPath, strokePath, drawText, typeset, newFont, rgb()" },
  { js: "return an SVG with the message, or frameos.error()", nim: "renderError(...)" },
  { js: "frameos.image({dataUrl|base64, width, height}) and let the runtime scale", nim: "scaleAndDrawImage, decodeImageWithDisplayBounds" },
  { js: "NO equivalent in an app — feed a data/clock or a format() code node into a field", nim: "times.now().format, chrono" },
  { js: "NO equivalent — do not fake it; report it as unsupported", nim: "runShellWithParentStreams, EXIF, dither, blake2b, files outside assets, frameConfig.debug, decode-target hints" },
];

function table(rows: Mapping[]): string {
  return ["| Nim | JavaScript |", "|---|---|", ...rows.map((row) => `| ${row.nim} | ${row.js} |`)].join("\n");
}

export const DELIVER_TOOL_NAME = "deliver_conversion";

export const deliverConversionTool: ModelTool = {
  description:
    "Deliver the converted JavaScript. For an app send `files` (COMPLETE contents of app.ts, plus config.json " +
    "when its category, fields or output change; never a diff). For a code node send `codeJS` (one expression). " +
    "When a faithful port is impossible send `unsupported` with the reason and nothing else — never a stub " +
    "that pretends to work.",
  name: DELIVER_TOOL_NAME,
  parameters: {
    additionalProperties: false,
    properties: {
      codeJS: {
        description: "Code node only: the single JavaScript expression for data.codeJS.",
        type: "string",
      },
      files: {
        additionalProperties: { type: "string" },
        description: 'App only: {"app.ts": "...", "config.json": "..."} — complete file contents.',
        type: "object",
      },
      notes: {
        description: "One or two sentences: what changed, and any behaviour that differs from the Nim.",
        type: "string",
      },
      unsupported: {
        description: "Why no faithful JavaScript port exists (one or two sentences). Send INSTEAD of files/codeJS.",
        type: "string",
      },
    },
    required: ["notes"],
    type: "object",
  },
};

export function buildConvertInstructions(options: { typeDeclarations?: string | undefined } = {}): string {
  const declarations = options.typeDeclarations?.trim();
  return `
You port legacy FrameOS scene code from Nim to JavaScript. FrameOS frames used to compile every scene into the
binary; today scenes are interpreted: JavaScript runs in QuickJS on the frame. Your job is ONE faithful port at a
time — same behaviour, same state keys, same outputs — delivered through the ${DELIVER_TOOL_NAME} tool. Nothing
outside the tool call is applied.

## Two sandboxes

**Code nodes** hold ONE JavaScript expression (data.codeJS). Globals: \`state.<key>\` (the scene state, any key),
every declared argument by name, \`context\` ({event, payload, loopIndex, loopKey, hasImage, imageWidth,
imageHeight}), \`now()\` (seconds since epoch), \`format(ts, pattern)\` and \`parseTs(pattern, text)\` with curly
tokens ({year/4} {month/2} {day/2} {hour/2} {minute/2} {second/2} {weekday} {month/n} {hour/2/ap} {am/pm}),
\`console.log\`. NO \`frameos\` object, NO fetch, NO require. Multi-statement logic goes in an IIFE:
\`(() => { const x = …; return x })()\`. Never redeclare an argument. Argument names \`state, args, context,
console, format, now, parseTs, getargor\` are reserved — the converter has already renamed any such argument;
use the names you are given.

**Scene-local apps** are modules in the app sandbox. \`app.config\` holds the fields, \`app.state\` IS the scene
state (read \`app.state.key\`, write with \`frameos.setState(key, value)\`), \`app.frame\` = {width, height, rotate,
assetsPath, timeZone}, \`app.log()\`, \`app.logError()\`. Helpers: \`frameos.fetchJson(url)\`, \`frameos.fetchText(url)\`,
\`frameos.httpRequest(url, opts)\`, \`frameos.svg(svg)\`, \`frameos.image(spec)\`, \`frameos.setState(k, v)\`,
\`frameos.setNextSleep(s)\`, \`frameos.error(msg)\`, \`frameos.readAsset/writeAsset\`. NO \`format()\`/\`now()\`
(use \`Date\`, UTC only), NO npm, NO async/await/Promises (nothing pumps the job queue — every call is synchronous),
NO DOM. The export the runtime calls depends on the wiring you are told: a chain app (between prev/next handles)
exports \`run(app, context)\`; an app that feeds a field exports \`get(app, context)\` and RETURNS the value.

A Nim app with category "render" (draws on context.image with pixie) has no JS twin that draws: it becomes a DATA
app whose \`get()\` returns \`frameos.svg("<svg …>…</svg>")\`, with config.json category "data" and
output [{"name": "image", "type": "image"}]; the converter wires a render/image node after it. The SVG subset:
svg (with viewBox), g, path, rect, circle, ellipse, line, polyline, polygon, text/tspan, linearGradient,
radialGradient (gradientUnits="userSpaceOnUse"), defs. NOT: use, image, filter, mask, clipPath, pattern, style,
foreignObject. Size the SVG from app.frame.width/height, never a hard-coded canvas.

## Mapping — code nodes

${table(codeNodeMappings)}

## Mapping — apps

${table(appMappings)}

## Rules

- Same state keys, same output type, same fields. Keep config.json's fields and name; change category/output
  only when the wiring demands it (say so in notes).
- TypeScript is fine (types are erased); keep it readable, no clever tricks.
- Where the Nim does something with NO equivalent (shell, files outside assets, dithering, EXIF, drawing
  primitives with no SVG form), do not fake it: send \`unsupported\` with the reason. A partial port that silently
  drops behaviour is worse than no port.
- Deliver through the tool. Do not paste code in prose.
${declarations ? `\n## Ambient type declarations (what the app sandbox exposes)\n\n\`\`\`ts\n${declarations}\n\`\`\`\n` : ""}
`.trim();
}
