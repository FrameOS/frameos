"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import versions from "../../../../../versions.json";

// FrameOS uses CalVer like 2026.7.3; the server's normalizeFrameosVersion
// accepts the same shape.
const versionPattern = /^\d{4}\.\d{1,2}\.\d{1,3}$/;

// The release this cloud was built with (versions.json, a build input of
// auth-web): what "Use current version" sets. Null on a dev checkout.
const currentFrameosVersion = ((): string | null => {
  const version = versions.frameos.split("+")[0] ?? "";
  return versionPattern.test(version) ? version : null;
})();

// Owner override for compatibility metadata, in the workspace's draft: the
// oldest FrameOS release that can run the scene. Save publishes it into
// template.json, the version and repository.json together.
export function SceneFrameosVersionEditor({
  frameosVersion,
  onChange,
}: {
  frameosVersion: string | null;
  onChange: (frameosVersion: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(frameosVersion ?? "");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const trimmed = value.trim();
    if (trimmed && !versionPattern.test(trimmed)) {
      setError("Use a version such as 2026.7.5.");
      return;
    }
    setError(null);
    setEditing(false);
    onChange(trimmed || null);
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
        {frameosVersion
          ? `Minimum FrameOS version: ${frameosVersion}`
          : "Set minimum FrameOS version"}
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
            commit();
          } else if (event.key === "Escape") {
            setEditing(false);
            setError(null);
          }
        }}
        placeholder={currentFrameosVersion ?? "2026.7.5"}
        value={value}
      />
      <button className="button" onClick={commit} type="button">
        <Check aria-hidden size={14} />
        Done
      </button>
      {currentFrameosVersion && value.trim() !== currentFrameosVersion ? (
        <button
          className="button button--subtle"
          onClick={() => {
            setError(null);
            setEditing(false);
            onChange(currentFrameosVersion);
          }}
          title={`Set FrameOS ${currentFrameosVersion}, the current release, as the minimum`}
          type="button"
        >
          Use current version ({currentFrameosVersion})
        </button>
      ) : null}
      <button
        aria-label="Cancel"
        className="button button--subtle"
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
