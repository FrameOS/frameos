"use client";

import { describeReport, type ConversionReport } from "@frameos-cloud/scene-convert";
import { ArrowRightLeft, Download, Save, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";

// env.ts's myScenesPath, repeated here so this client component does not pull
// the server-side env module into the browser bundle.
const maxFileBytes = 3 * 1024 * 1024;

type ConvertReply = {
  ok: boolean;
  scene?: unknown;
  scenes?: unknown[];
  reports: ConversionReport[];
  lint: { errors: { message: string; node?: string; scene: string }[]; warnings: { message: string; node?: string; scene: string }[] };
  render: { sceneId: string; ok: boolean; renderMs: number | null; errors: string[] }[] | null;
  model: { calls: number; name: string | null; source: "request" | "account" | "shared" | "none"; usage: { inputTokens: number; outputTokens: number } };
};

const errorMessages: Record<string, string> = {
  invalid_openai_key: "That OpenAI key was not accepted.",
  invalid_scenes: "That is not a FrameOS scene: expected one scene object, a scenes.json array, or {\"scenes\": [...]}.",
  model_budget_exhausted: "The free model pass is out of budget right now. Try again later, or use your own OpenAI key below.",
  model_failed: "The model pass failed on OpenAI's side — try again in a moment.",
  rate_limited: "Too many conversions from this address — wait a minute and try again.",
  scenes_payload_too_large: "That file is too large (3 MB max).",
  too_many_scenes: "At most 20 scenes per conversion.",
};

function sceneNameOf(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const first = Array.isArray(parsed) ? parsed[0] : (parsed as { scenes?: unknown[] })?.scenes?.[0] ?? parsed;
    const name = (first as { name?: unknown })?.name;
    return typeof name === "string" && name.trim() ? name.trim() : "scene";
  } catch {
    return "scene";
  }
}

/**
 * The converter page's body: a drop zone or paste box, one button, the
 * report, the download — and "Save to my scenes" for a signed-in visitor.
 * The work happens in POST /api/scenes/convert; this only carries JSON
 * there and back.
 */
export function NimConverter({
  loginUrl,
  myScenesUrl,
  sharedModelPass,
  signedIn,
}: {
  loginUrl: string;
  myScenesUrl: string;
  /** Whether the server pays for the model pass when no key is given. */
  sharedModelPass: boolean;
  signedIn: boolean;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<ConvertReply | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ name: string; url: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const converted = useMemo(() => {
    if (!reply) {
      return null;
    }
    const output = reply.scene !== undefined ? reply.scene : reply.scenes;
    return `${JSON.stringify(output, null, 2)}\n`;
  }, [reply]);

  const downloadUrl = useMemo(() => {
    if (!converted) {
      return null;
    }
    return URL.createObjectURL(new Blob([converted], { type: "application/json" }));
  }, [converted]);
  useEffect(() => () => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
    }
  }, [downloadUrl]);

  const downloadName = (fileName ?? `${sceneNameOf(text)}.json`).replace(/\.json$/i, "") + ".js.json";

  async function readFile(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.size > maxFileBytes) {
      setError("That file is too large (3 MB max).");
      return;
    }
    setText(await file.text());
    setFileName(file.name);
    setPasting(false);
    setError(null);
    setReply(null);
    setSaved(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void readFile(event.dataTransfer.files?.[0]);
  }

  async function convert() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    setReply(null);
    setSaved(null);
    try {
      const body: Record<string, unknown> = Array.isArray(parsed) ? { scenes: parsed } : { scene: parsed };
      if (apiKey.trim()) {
        body.openaiApiKey = apiKey.trim();
      }
      const response = await fetch("/api/scenes/convert", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as ConvertReply & { error?: string; hint?: string; retry_after?: number };
      if (!response.ok) {
        const code = payload.error ?? String(response.status);
        setError(errorMessages[code] ?? `Conversion failed: ${code}${payload.hint ? ` — ${payload.hint}` : ""}`);
        return;
      }
      setReply(payload);
    } catch {
      setError("Conversion failed — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function saveToMyScenes() {
    if (!reply) {
      return;
    }
    const scenes = reply.scene !== undefined ? [reply.scene] : (reply.scenes ?? []);
    setSaving(true);
    setSaveError(null);
    try {
      const name = sceneNameOf(converted ?? "");
      const response = await fetch("/api/account/scenes", {
        body: JSON.stringify({ name, scenes }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; scene?: { name?: string; id?: string } };
      if (!response.ok) {
        setSaveError(`Could not save: ${payload.error ?? response.status}`);
        return;
      }
      setSaved({ name: payload.scene?.name ?? name, url: myScenesUrl });
    } catch {
      setSaveError("Could not save — check your connection.");
    } finally {
      setSaving(false);
    }
  }

  const needsModel = reply ? reply.reports.reduce((n, report) => n + report.needsModel.length, 0) : 0;
  const needsManualPort = reply ? reply.reports.reduce((n, report) => n + report.needsManualPort.length, 0) : 0;

  return (
    <div className="nim-converter stack-lg">
      <p className="section-description">
        A scene with <code>execution: compiled</code> — Nim code nodes, a scene-local Nim app — needs a source build
        on every deploy. Drop its JSON here and get the same scene in JavaScript, which runs on the released
        binaries and previews in the browser. The Nim stays in the file next to the JavaScript, so switching the
        scene back to compiled undoes it. Nothing is stored.
        {sharedModelPass ? " The AI pass is on us, within a daily budget." : " Bring an OpenAI key for the AI pass; without one only the deterministic pass runs."}
      </p>

      <div
        className={dragging ? "card nim-converter__drop nim-converter__drop--active" : "card nim-converter__drop"}
        data-testid="nim-converter-drop"
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={onDrop}
      >
        {pasting ? (
          <textarea
            aria-label="Scene JSON"
            className="nim-converter__paste"
            onChange={(event) => {
              setText(event.target.value);
              setFileName(null);
              setReply(null);
              setSaved(null);
              setError(null);
            }}
            placeholder='{"id": "…", "name": "…", "nodes": [...], "edges": [...], "settings": {"execution": "compiled"}}'
            rows={12}
            spellCheck={false}
            value={text}
          />
        ) : (
          <div className="nim-converter__drop-copy">
            <Upload aria-hidden size={28} />
            <p>
              {fileName ? (
                <>
                  <strong>{fileName}</strong> — {Math.ceil(text.length / 1024)} KB, ready.
                </>
              ) : (
                <>Drop a scene.json, a scenes.json or a scene export here.</>
              )}
            </p>
            <input
              accept=".json,application/json"
              aria-label="Scene JSON file"
              hidden
              onChange={(event) => void readFile(event.target.files?.[0])}
              ref={fileInput}
              type="file"
            />
            <div className="button-row">
              <button className="button button--subtle" onClick={() => fileInput.current?.click()} type="button">
                Choose a file
              </button>
              <button className="button button--subtle" onClick={() => setPasting(true)} type="button">
                Paste JSON instead
              </button>
            </div>
          </div>
        )}
      </div>

      <details className="nim-converter__key" open={showKey}>
        <summary onClick={(event) => { event.preventDefault(); setShowKey((value) => !value); }}>
          Use my own OpenAI key
        </summary>
        <p className="section-description">
          Sent with this conversion only and never stored. The key pays for the AI pass (scene-local Nim apps and
          any code node the deterministic pass could not translate).
        </p>
        <input
          aria-label="OpenAI API key"
          autoComplete="off"
          className="input"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-…"
          type="password"
          value={apiKey}
        />
      </details>

      <div className="button-row">
        <button className="button button-primary" disabled={busy || !text.trim()} onClick={() => void convert()} type="button">
          <ArrowRightLeft aria-hidden size={16} />
          {busy ? "Converting…" : "Convert to JavaScript"}
        </button>
        {busy ? <span className="nim-converter__busy">The AI pass can take a minute per app.</span> : null}
      </div>

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {reply ? (
        <section className="card stack" data-testid="nim-converter-result">
          <h3>
            {reply.ok
              ? "Converted — the scene is interpreted now."
              : needsModel > 0
                ? "Partly converted — the rest needs the AI pass."
                : "Partly converted — some parts need a manual port."}
          </h3>
          <p className="section-description">
            {reply.model.calls > 0
              ? `${reply.model.calls} model call${reply.model.calls === 1 ? "" : "s"} (${reply.model.name ?? "model"}, ${reply.model.source === "shared" ? "on us" : reply.model.source === "request" ? "your key" : "your account's key"}). `
              : needsModel > 0
                ? "No AI pass ran: add an OpenAI key above to convert the parts listed as needing the model. "
                : ""}
            {reply.lint.errors.length > 0
              ? `${reply.lint.errors.length} lint error${reply.lint.errors.length === 1 ? "" : "s"} in the result — the JSON is returned anyway; open it in the editor to see them. `
              : "Lints clean. "}
            {reply.render
              ? reply.render.every((check) => check.ok)
                ? "Renders without errors."
                : "Rendered with errors (see the log lines below)."
              : null}
            {needsManualPort > 0 ? ` ${needsManualPort} item${needsManualPort === 1 ? "" : "s"} carry a needsConversion note in the JSON.` : null}
          </p>
          <div className="button-row">
            {downloadUrl ? (
              <a className="button button-primary" download={downloadName} href={downloadUrl}>
                <Download aria-hidden size={16} />
                Download {downloadName}
              </a>
            ) : null}
            {signedIn ? (
              <button className="button" disabled={saving || Boolean(saved)} onClick={() => void saveToMyScenes()} type="button">
                <Save aria-hidden size={16} />
                {saving ? "Saving…" : saved ? "Saved" : "Save to my scenes"}
              </button>
            ) : (
              <a className="button" href={loginUrl}>
                Sign in to save it to my scenes
              </a>
            )}
          </div>
          {saved ? (
            <p className="notice" role="status">
              Saved as a private scene: <a href={saved.url}>{saved.name}</a>
            </p>
          ) : null}
          {saveError ? (
            <p className="notice notice-error" role="alert">
              {saveError}
            </p>
          ) : null}
          {reply.reports.map((report) => (
            <details className="nim-converter__report" key={report.sceneId} open={reply.reports.length === 1}>
              <summary>
                {report.sceneName} — {report.executionBefore} → {report.executionAfter}
              </summary>
              <ul className="nim-converter__lines">
                {describeReport(report).map((line, index) => (
                  <li key={index}>
                    <code>{line}</code>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {reply.lint.errors.length > 0 ? (
            <details className="nim-converter__report">
              <summary>Lint errors ({reply.lint.errors.length})</summary>
              <ul className="nim-converter__lines">
                {reply.lint.errors.map((entry, index) => (
                  <li key={index}>
                    <code>
                      {entry.scene}
                      {entry.node ? ` / ${entry.node}` : ""}: {entry.message}
                    </code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {reply.render?.some((check) => !check.ok) ? (
            <details className="nim-converter__report">
              <summary>Render errors</summary>
              <ul className="nim-converter__lines">
                {reply.render.flatMap((check) => check.errors.map((line, index) => (
                  <li key={`${check.sceneId}-${index}`}>
                    <code>{line}</code>
                  </li>
                )))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <details className="nim-converter__api">
        <summary>The same thing from a terminal</summary>
        <pre className="code-block">{`curl -sS -X POST ${typeof window === "undefined" ? "" : window.location.origin}/api/scenes/convert \\
  -H 'content-type: application/json' \\
  --data-binary @scene.json > scene.js.json

# add "openaiApiKey" to the body to pay for the AI pass yourself; "dryRun": true skips it.
# offline, in the FrameOS repo:
pnpm --filter @frameos-cloud/scene-convert convert scene.json --out scene.js.json`}</pre>
      </details>
    </div>
  );
}
