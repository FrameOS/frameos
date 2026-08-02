"use client";

import { Check, Pencil, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Owner override for compatibility metadata. The server publishes a new ZIP
// version so template.json, the version table, and repository.json agree.
export function SceneFrameosVersionEditor({
  frameosVersion,
  sceneId,
}: {
  frameosVersion: string | null;
  sceneId: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(frameosVersion ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/account/scenes/${sceneId}`, {
      body: JSON.stringify({ frameosVersion: value.trim() || null }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    setBusy(false);
    if (response.ok) {
      setEditing(false);
      router.refresh();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    setError(
      payload.error === "invalid_frameos_version"
        ? "Use a version such as 2026.7.5."
        : `Saving failed: ${payload.error ?? response.status}`,
    );
  }

  if (!editing) {
    return (
      <button
        className="tag-edit-button"
        onClick={() => {
          setValue(frameosVersion ?? "");
          setEditing(true);
        }}
        title="Set the oldest FrameOS release that can run this scene"
        type="button"
      >
        <Pencil aria-hidden size={14} />
        {frameosVersion ? "Edit minimum FrameOS version" : "Set minimum FrameOS version"}
      </button>
    );
  }

  return (
    <span className="tag-editor">
      <input
        aria-label="Minimum FrameOS version"
        autoFocus
        className="tag-editor__input"
        maxLength={32}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void save();
          }
        }}
        placeholder="2026.7.5"
        value={value}
      />
      <button className="button" disabled={busy} onClick={() => void save()} type="button">
        <Check aria-hidden size={14} />
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        className="button button--subtle"
        disabled={busy}
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
        type="button"
      >
        <X aria-hidden size={14} />
      </button>
      {error ? <span className="pill pill-warning">{error}</span> : null}
    </span>
  );
}
