"use client";

import { Sparkles, Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CreateSceneWithAiBox } from "./CreateSceneWithAiBox";
import { SceneZipUpload } from "./SceneZipUpload";

type ActionKey = "ai" | "zip";

// The two ways to get a new scene into your account, as the card buttons
// frameos.net uses for its setup choices: a tinted gradient with a grain
// overlay, a soft glow, the icon ghosted large in the corner and again as
// a small badge. Pressing a card opens its form right below the row;
// pressing it again folds it away. The store front only offers the AI
// card (the ZIP upload lives on "My scenes").
export function StoreActionCards({
  aiAction,
  showUpload,
}: {
  aiAction: string;
  showUpload: boolean;
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
        {showUpload ? (
          <ActionCard
            description="Upload a scene export. New uploads are private; uploading the same scene name again creates a new version."
            icon={<Upload aria-hidden />}
            onClick={() => toggle("zip")}
            pressed={open === "zip"}
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
      {open === "zip" && showUpload ? (
        <div className="action-cards__form" data-testid="action-card-form">
          <SceneZipUpload compact />
        </div>
      ) : null}
    </div>
  );
}

function ActionCard({
  description,
  icon,
  onClick,
  pressed,
  testId,
  tint,
  title,
}: {
  description: string;
  icon: ReactNode;
  onClick: () => void;
  pressed: boolean;
  testId: string;
  tint: "gold" | "teal";
  title: string;
}) {
  return (
    <button
      aria-expanded={pressed}
      aria-pressed={pressed}
      className={`action-card action-card--${tint}`}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
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
    </button>
  );
}
