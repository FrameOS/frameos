import { redirect } from "next/navigation";
import { NewSceneWithAi } from "../../../src/components/NewSceneWithAi";
import {
  getCloudBaseUrl,
  getFramesUrl,
  getMyScenesUrl,
  getScenesBaseUrl,
  myScenesPath,
} from "../../../src/lib/env";
import { readSession } from "../../../src/lib/session";

export const metadata = { title: "New scene" };

export const dynamic = "force-dynamic";

// A new private scene built with the AI: a full-page editor starting from
// one blank scene, the AI panel open, and "Save to my scenes" creating the
// scene in the account. Sign-in required, like /my-scenes; the ?prompt= from
// the store's "Create a scene with AI" box survives the login round-trip.
export default async function NewScenePage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const { prompt: promptParam } = await searchParams;
  const prompt = promptParam?.trim().slice(0, 2000) || undefined;
  const session = await readSession();
  if (!session) {
    const returnTo = new URL(`${myScenesPath}/new`, getScenesBaseUrl());
    if (prompt) {
      returnTo.searchParams.set("prompt", prompt);
    }
    const loginUrl = new URL("/login", getCloudBaseUrl());
    loginUrl.searchParams.set("return_to", returnTo.toString());
    redirect(loginUrl.toString());
  }
  return (
    <NewSceneWithAi
      initialPrompt={prompt}
      loginUrl={new URL("/login", getCloudBaseUrl()).toString()}
      myScenesUrl={getMyScenesUrl()}
      settingsUrl={`${getFramesUrl()}/settings#settings-openai`}
    />
  );
}
