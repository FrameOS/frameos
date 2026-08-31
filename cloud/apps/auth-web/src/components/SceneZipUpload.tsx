"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const maxZipBytes = 8 * 1024 * 1024;

const uploadErrors: Record<string, string> = {
  content_rejected: "Rejected by content moderation",
  daily_scene_limit_exceeded: "Daily new-scene limit reached",
  invalid_name: "The ZIP's template.json needs a scene name",
  invalid_template_json: "template.json is not valid",
  invalid_upload: "Choose a FrameOS scene ZIP",
  invalid_zip: "That file is not a valid ZIP",
  login_required: "Sign in to upload a scene",
  missing_scenes: "The ZIP has no scenes",
  missing_template_json: "The ZIP has no template.json",
  moderation_unavailable: "Moderation service unavailable — try again later",
  scene_pulled: "This scene was pulled and cannot be republished",
  scene_quota_exceeded: "Scene limit reached",
  scene_requires_compilation:
    "This is a legacy compiled scene (Nim code nodes or Nim apps). Convert it to an interpreted scene at /nim-converter first.",
  scene_too_large: "ZIP is too large (max 8 MB)",
  storage_quota_exceeded: "Cloud scene storage limit reached",
  store_banned: "This account cannot publish scenes",
};

export function SceneZipUpload({
  compact = false,
}: {
  /** Just the file row — the card that opened it already says what it is. */
  compact?: boolean;
} = {}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) {
      setMessage({ kind: "error", text: "Choose a FrameOS scene ZIP" });
      return;
    }
    if (file.size > maxZipBytes) {
      setMessage({ kind: "error", text: "ZIP is too large (max 8 MB)" });
      return;
    }

    setBusy(true);
    setMessage(null);
    const body = new FormData();
    body.set("file", file);

    try {
      const response = await fetch("/api/account/scenes/upload", {
        body,
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        scene?: { name?: string; version?: number };
      };
      if (!response.ok) {
        const error = payload.error ?? String(response.status);
        setMessage({
          kind: "error",
          text: uploadErrors[error] ?? `Upload failed: ${error}`,
        });
        return;
      }

      const name = payload.scene?.name ?? file.name;
      const version = payload.scene?.version;
      setFile(null);
      setMessage({
        kind: "success",
        text: `Uploaded ${name}${version ? ` (v${version})` : ""}`,
      });
      form.reset();
      router.refresh();
    } catch {
      setMessage({
        kind: "error",
        text: "Upload failed — check your connection",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={
        compact
          ? "card scene-zip-upload scene-zip-upload--compact"
          : "card scene-zip-upload"
      }
      onSubmit={(event) => void submit(event)}
    >
      {compact ? null : (
        <div>
          <h3>Upload a scene ZIP</h3>
          <p>
            Upload a scene export. New uploads are private; uploading the
            same scene name again creates a new version.
          </p>
        </div>
      )}
      <div className="scene-zip-upload__controls">
        <input
          accept=".zip,application/zip,application/x-zip-compressed"
          aria-label="FrameOS scene ZIP"
          className="input"
          disabled={busy}
          name="file"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setMessage(null);
          }}
          required
          type="file"
        />
        <button className="button" disabled={busy || !file} type="submit">
          <Upload aria-hidden size={16} />
          {busy ? "Uploading…" : "Upload ZIP"}
        </button>
      </div>
      {message ? (
        <p
          className={
            message.kind === "error" ? "notice notice-error" : "notice"
          }
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
