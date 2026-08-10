"use client";

import {
  Bold,
  Check,
  Eye,
  Heading3,
  Italic,
  Link2,
  List as ListIcon,
  Pencil,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { SceneMarkdown } from "./SceneMarkdown";

// Owner editing of a scene's description on the scene page, saved through the
// account scene PATCH (moderated server-side like every public-page edit).
export function SceneDescriptionEditor({
  description,
  sceneId,
}: {
  description: string | null;
  sceneId: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorTab, setEditorTab] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function wrapSelection(prefix: string, suffix: string, placeholder: string) {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${prefix}${selected}${suffix}${value.slice(end)}`;
    if (next.length > 2000) {
      return;
    }
    setValue(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length,
      );
    });
  }

  function prefixLines(prefix: string) {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const selected = value.slice(lineStart, end) || "Item";
    const replacement = selected
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
    const next = `${value.slice(0, lineStart)}${replacement}${value.slice(end)}`;
    if (next.length > 2000) {
      return;
    }
    setValue(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart, lineStart + replacement.length);
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    const trimmed = value.trim();
    const response = await fetch(`/api/account/scenes/${sceneId}`, {
      body: JSON.stringify({ description: trimmed || null }),
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
    if (payload.error === "content_rejected") {
      const categories = Array.isArray(payload.categories)
        ? ` (${payload.categories.join(", ")})`
        : "";
      setError(`Rejected by content moderation${categories}`);
    } else if (payload.error === "moderation_unavailable") {
      setError("Moderation service unavailable — try again later");
    } else {
      setError(`Saving failed: ${payload.error ?? response.status}`);
    }
  }

  if (!editing) {
    return (
      <div className="stack" style={{ gap: "4px" }}>
        <SceneMarkdown description={description} />
        <div>
          <button
            className="tag-edit-button"
            onClick={() => {
              setValue(description ?? "");
              setEditorTab("write");
              setEditing(true);
            }}
            title="Edit description"
            type="button"
          >
            <Pencil aria-hidden size={14} />
            Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: "8px" }}>
      <div className="markdown-editor">
        <div className="markdown-editor__header">
          <div aria-label="Markdown formatting" className="markdown-editor__toolbar" role="toolbar">
            <button
              aria-label="Heading"
              disabled={editorTab !== "write"}
              onClick={() => prefixLines("### ")}
              title="Heading"
              type="button"
            >
              <Heading3 aria-hidden size={17} />
            </button>
            <button
              aria-label="Bold"
              disabled={editorTab !== "write"}
              onClick={() => wrapSelection("**", "**", "bold text")}
              title="Bold"
              type="button"
            >
              <Bold aria-hidden size={17} />
            </button>
            <button
              aria-label="Italic"
              disabled={editorTab !== "write"}
              onClick={() => wrapSelection("_", "_", "italic text")}
              title="Italic"
              type="button"
            >
              <Italic aria-hidden size={17} />
            </button>
            <button
              aria-label="Link"
              disabled={editorTab !== "write"}
              onClick={() => wrapSelection("[", "](https://)", "link text")}
              title="Link"
              type="button"
            >
              <Link2 aria-hidden size={17} />
            </button>
            <button
              aria-label="Bulleted list"
              disabled={editorTab !== "write"}
              onClick={() => prefixLines("- ")}
              title="Bulleted list"
              type="button"
            >
              <ListIcon aria-hidden size={17} />
            </button>
          </div>
          <div className="markdown-editor__tabs">
            <button
              aria-pressed={editorTab === "write"}
              className={editorTab === "write" ? "is-active" : undefined}
              onClick={() => setEditorTab("write")}
              type="button"
            >
              <Pencil aria-hidden size={15} />
              Write
            </button>
            <button
              aria-pressed={editorTab === "preview"}
              className={editorTab === "preview" ? "is-active" : undefined}
              onClick={() => setEditorTab("preview")}
              type="button"
            >
              <Eye aria-hidden size={15} />
              Preview
            </button>
          </div>
        </div>
        {editorTab === "write" ? (
          <textarea
            aria-label="Scene description"
            className="markdown-editor__textarea"
            maxLength={2000}
            onChange={(event) => setValue(event.target.value)}
            placeholder="What does this scene show, and on what kind of frame does it look best?"
            ref={textareaRef}
            rows={8}
            value={value}
          />
        ) : (
          <div className="markdown-editor__preview">
            <SceneMarkdown description={value || null} />
          </div>
        )}
        <div className="markdown-editor__footer">
          <span>Markdown supported</span>
          <span>{value.length} / 2000</span>
        </div>
      </div>
      <div className="button-row">
        <button
          className="button"
          disabled={busy}
          onClick={() => void save()}
          type="button"
        >
          <Check aria-hidden size={16} />
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          className="button button--subtle"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          type="button"
        >
          <X aria-hidden size={16} />
          Cancel
        </button>
        {error ? <span className="pill pill-warning">{error}</span> : null}
      </div>
    </div>
  );
}
