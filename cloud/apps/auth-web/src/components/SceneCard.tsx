import Link from "next/link";
import { formatDate } from "../lib/format";

export type SceneCardScene = {
  description: string | null;
  downloadCount: number;
  frameosVersion?: string | null;
  hasPreview: boolean;
  id: string;
  name: string;
  publisher: string | null;
  riskFlags?: string[];
  slug: string;
  tags?: string[];
  updatedAt: Date;
};

export function SceneCard({ scene }: { scene: SceneCardScene }) {
  return (
    <Link className="scene-card" href={`/s/${scene.slug}`}>
      {scene.hasPreview ? (
        // Served by our own image route with a fixed content type.
        <img
          alt=""
          className="scene-card__image"
          loading="lazy"
          src={`/api/store/scenes/${scene.id}/image`}
        />
      ) : (
        <div aria-hidden className="scene-card__placeholder">
          No preview
        </div>
      )}
      <h3>
        {scene.name}
        {scene.riskFlags?.includes("shell") ? (
          <span
            className="risk-badge"
            title="This scene configures apps or code that run shell commands on the frame"
          >
            runs shell commands
          </span>
        ) : null}
      </h3>
      {scene.description ? <p className="copy">{scene.description}</p> : null}
      {scene.tags && scene.tags.length > 0 ? (
        <div className="tag-list">
          {scene.tags.slice(0, 4).map((tag) => (
            // The whole card is a link; tags render as plain pills here and
            // are clickable filters on the scene page.
            <span className="tag-pill" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="scene-card__meta">
        <span>{scene.publisher ?? "FrameOS user"}</span>
        <span>·</span>
        <span>
          {scene.downloadCount} download{scene.downloadCount === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>{formatDate(scene.updatedAt)}</span>
        {scene.frameosVersion ? (
          <>
            <span>·</span>
            <span title={`Requires FrameOS ${scene.frameosVersion} or newer`}>
              FrameOS {scene.frameosVersion}
            </span>
          </>
        ) : null}
      </div>
    </Link>
  );
}
