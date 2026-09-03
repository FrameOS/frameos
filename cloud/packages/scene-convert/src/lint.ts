// The handful of checks the model most often fails, run on its output before
// it is accepted so the next attempt can be told what was wrong. The full
// structural linter (cloud/apps/auth-web/src/lib/ai/scene-lint.ts) needs the
// bundled app catalog and runs on the whole scene afterwards; these are the
// per-file rules it applies to JavaScript, kept small and dependency-free
// so the CLI has them too. Keep the two in step.

const importSpecifierPattern = /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]|^\s*import\s*['"]([^'"\n]+)['"]/gm;

function exportsFunction(source: string, name: string): boolean {
  return new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+(?:const|let)\\s+${name}\\b|exports\\.${name}\\s*=`,
  ).test(source);
}

/** Problems with one converted app: its files, and what the runtime will call. */
export function lintConvertedApp(
  files: Record<string, string>,
  expectedExport: "get" | "run",
  category: string | undefined,
): string[] {
  const problems: string[] = [];
  const main = files["app.ts"] ?? files["app.tsx"] ?? files["app.js"] ?? files["app.jsx"];
  if (main === undefined) {
    problems.push("no app.ts (or app.tsx/app.js/app.jsx) in the delivered files");
    return problems;
  }
  if (category === "render") {
    problems.push(
      'category "render" scene-local apps draw nothing in the runtime. Make it category "data" with `export function get(app, context)` returning frameos.svg(...) and output [{name: "image", type: "image"}].',
    );
  }
  if (!exportsFunction(main, expectedExport)) {
    problems.push(
      expectedExport === "run"
        ? "the app sits in the render chain, so app.ts must `export function run(app, context)`"
        : "the app feeds a field, so app.ts must `export function get(app, context)` returning the output value",
    );
  }
  if (/(^|[^.\w])(?:format|now|parseTs)\s*\(/.test(main)) {
    problems.push(
      "JS apps have no format()/now()/parseTs() (those exist only in code nodes). Use Date (UTC only) or take the formatted value in through a field.",
    );
  }
  if (/\b(?:async\s+function|await\s|\.then\s*\()/.test(main)) {
    problems.push("the runtime never resolves Promises: no async/await/.then — every frameos.* call is synchronous");
  }
  if (/\brequire\s*\(/.test(main)) {
    problems.push("no require(): only relative imports of the app's own files");
  }
  const fileNames = Object.keys(files);
  for (const [name, source] of Object.entries(files)) {
    if (!/\.(ts|tsx|js|jsx)$/.test(name)) {
      continue;
    }
    for (const match of source.matchAll(importSpecifierPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) {
        continue;
      }
      if (!specifier.startsWith(".")) {
        problems.push(`${name} imports "${specifier}" — npm packages are not available on a frame; only the app's own files`);
      } else if (!resolvesToFile(name, specifier, fileNames)) {
        problems.push(`${name} imports "${specifier}", but no such file was delivered (files: ${fileNames.join(", ")})`);
      }
    }
  }
  if (files["config.json"] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(files["config.json"]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push("config.json must be a JSON object");
      }
    } catch {
      problems.push("config.json is not valid JSON");
    }
  }
  return problems;
}

function resolvesToFile(fromFile: string, specifier: string, files: string[]): boolean {
  const parts = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const joined = parts.join("/");
  const candidates = [joined, ...[".ts", ".tsx", ".js", ".jsx", ".json"].map((ext) => joined + ext)];
  if (joined.endsWith(".js")) {
    candidates.push(`${joined.slice(0, -3)}.ts`, `${joined.slice(0, -3)}.tsx`);
  }
  return candidates.some((candidate) => files.includes(candidate));
}

/** Problems with one converted code-node expression. */
export function lintConvertedCodeNode(codeJS: string, argNames: string[]): string[] {
  const problems: string[] = [];
  if (!codeJS.trim()) {
    problems.push("codeJS is empty");
    return problems;
  }
  for (const name of argNames) {
    // The name is scene-supplied: escape it, or "[" throws and "(a*)*c" backtracks forever.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^.\\w])(?:const|let|var|function|class)\\s+${escaped}\\b`).test(codeJS)) {
      problems.push(`redeclares the argument "${name}" (it is already a const from codeArgs)`);
    }
  }
  if (/\bframeos\s*\./.test(codeJS)) {
    problems.push("code nodes have no `frameos` object (no fetchJson/svg/setState there)");
  }
  if (/\bfetch\s*\(/.test(codeJS) || /\bXMLHttpRequest\b/.test(codeJS)) {
    problems.push("code nodes cannot make HTTP requests");
  }
  if (/^\s*(?:const|let|var|return|if|for|while)\b/.test(codeJS)) {
    problems.push("codeJS must be ONE expression — wrap statements in an IIFE: (() => { ...; return value })()");
  }
  return problems;
}
