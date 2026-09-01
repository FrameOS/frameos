"use client";

import { FilePlus2, Sparkles, Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CreateSceneWithAiBox } from "./CreateSceneWithAiBox";
import { SceneZipUpload } from "./SceneZipUpload";

type ActionKey = "ai" | "zip";

// The three ways to get a new scene into your account, as the card buttons
// frameos.net uses for its setup choices: a tinted gradient with a grain
// overlay, a soft glow, the icon ghosted large in the corner and again as
// a small badge. Pressing a card opens its form right below the row;
// pressing it again folds it away.
//
// A file cannot survive a login round-trip the way the AI prompt does, so on
// the signed-out store front the ZIP card is a link to sign in first
// (uploadLoginHref) and the upload form itself waits on the other side.
export function StoreActionCards({
  aiAction,
  showUpload,
  uploadLoginHref,
}: {
  aiAction: string;
  showUpload: boolean;
  /** Signed out: the ZIP card links here (login) instead of opening a form. */
  uploadLoginHref?: string | undefined;
}) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  const toggle = (key: ActionKey) => setOpen((current) => (current === key ? null : key));

  return (
    <div className="action-cards">
      <div className="action-cards__row">
        <ActionCard
          description="Describe what you want on the display. The assistant builds it in the editor; you tweak it and save it to your scenes."
          icon={<Sparkles aria-hidden />}
          onClick={() => toggle("ai")}
          pressed={open === "ai"}
          testId="action-card-ai"
          tint="gold"
          title="Create a scene with AI"
        />
        {/* Straight into the editor with one empty scene. Same destination as
            the AI card, minus the prompt — /my-scenes/new starts blank when
            nothing is passed, and bounces through login on its own if there
            is no session yet. */}
        <ActionCard
          description="Start from an empty scene and build it yourself in the editor. The AI panel is there if you want it later."
          href={aiAction}
          icon={<FilePlus2 aria-hidden />}
          onClick={() => undefined}
          pressed={false}
          testId="action-card-blank"
          tint="slate"
          title="New blank scene"
        />
        {showUpload ? (
          <ActionCard
            description="Upload a scene export. New uploads are private; uploading the same scene name again creates a new version."
            href={uploadLoginHref}
            icon={<Upload aria-hidden />}
            onClick={() => toggle("zip")}
            pressed={open === "zip" && !uploadLoginHref}
            testId="action-card-zip"
            tint="teal"
            title="Upload a scene ZIP"
          />
        ) : null}
      </div>
      {open === "ai" ? (
        <div className="action-cards__form" data-testid="action-card-form">
          <CreateSceneWithAiBox action={aiAction} autoFocus compact />
        </div>
      ) : null}
      {open === "zip" && showUpload && !uploadLoginHref ? (
        <div className="action-cards__form" data-testid="action-card-form">
          <SceneZipUpload compact />
        </div>
      ) : null}
    </div>
  );
}

function ActionCard({
  description,
  href,
  icon,
  onClick,
  pressed,
  testId,
  tint,
  title,
}: {
  description: string;
  /** When set the card navigates instead of toggling a form open. */
  href?: string | undefined;
  icon: ReactNode;
  onClick: () => void;
  pressed: boolean;
  testId: string;
  tint: "gold" | "slate" | "teal";
  title: string;
}) {
  const className = `action-card action-card--${tint}`;
  const inside = (
    <>
      <span aria-hidden className="action-card__grain" />
      <span aria-hidden className="action-card__glow" />
      <span aria-hidden className="action-card__ghost">
        {icon}
      </span>
      <span className="action-card__badge">{icon}</span>
      <span className="action-card__text">
        <span className="action-card__title">{title}</span>
        <span className="action-card__description">{description}</span>
      </span>
    </>
  );

  if (href) {
    return (
      <a className={className} data-testid={testId} href={href}>
        {inside}
      </a>
    );
  }

  return (
    <button
      aria-expanded={pressed}
      aria-pressed={pressed}
      className={className}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      {inside}
    </button>
  );
}
