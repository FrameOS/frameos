import { Sparkles } from "lucide-react";

// A quiet one-line prompt box for the store front and "My scenes":
// describe a scene, land in the new-scene editor with the AI already working
// on it (/my-scenes/new?prompt=…; that page asks for sign-in first if
// needed). A plain GET form — no client JavaScript involved.
export function CreateSceneWithAiBox({ action }: { action: string }) {
  return (
    <form action={action} className="card ai-create-box" method="get">
      <div className="ai-create-box__text">
        <h3>
          <Sparkles aria-hidden size={16} />
          Create a scene with AI
        </h3>
        <p>
          Describe what you want on the display. The assistant builds it in the
          editor; you tweak it and save it to your scenes.
        </p>
      </div>
      <div className="ai-create-box__row">
        <input
          aria-label="Describe the scene you want"
          autoComplete="off"
          className="input"
          maxLength={2000}
          name="prompt"
          placeholder="A clock with today's weather for Berlin, big text on dark green…"
          required
          type="text"
        />
        <button className="button" type="submit">
          Create
        </button>
      </div>
    </form>
  );
}
