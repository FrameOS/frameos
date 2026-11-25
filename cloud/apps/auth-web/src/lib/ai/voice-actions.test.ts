// Voice actions (docs/voice-chat.md "Voice actions"): the cloud replays
// docs/voice-action-fixtures.json, the corpus the backend's voice_actions.py
// replays too — the request built for an utterance on a screen, the plan made
// of Jev's answers, the words to type, the chat's screen context and tools.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "./scene-utils";
import {
  buildDecision,
  decideVoiceAction,
  JevError,
  MAX_SCREEN_BYTES,
  planFromAnswers,
  readScreen,
  sceneVoiceEvents,
  screenContextBlock,
  textCandidates,
  VoiceScreenTools,
  type VoiceActionPlan,
  type VoiceScreen,
} from "./voice-actions";

type Corpus = {
  now: string;
  scenes: { id: string; name: string }[];
  screens: Record<string, JsonObject>;
  reads: { screen?: string; raw?: JsonObject; read: JsonObject | null }[];
  texts: { said: string; candidates: string[] }[];
  decisions: {
    name: string;
    screen: string;
    scene: JsonObject | null;
    said: string;
    request: JsonObject;
    answers: JsonObject;
    plan: JsonObject | null;
  }[];
  contexts: { screen: string; scene: JsonObject | null; block: string }[];
  tools: { screen: string; scene: JsonObject; said: string; calls: [string, JsonObject, JsonObject][]; events: JsonObject[] }[];
};

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../../docs/voice-action-fixtures.json"), "utf8"),
) as Corpus;
const now = new Date(corpus.now);
const screen = (name: string) => readScreen(JSON.stringify(corpus.screens[name])) as VoiceScreen;

function planJson(plan: VoiceActionPlan | null) {
  if (!plan) {
    return null;
  }
  const log = Object.fromEntries(Object.entries(plan.log).filter(([key]) => key !== "p" && key !== "targetP"));
  return { events: plan.events, kind: plan.kind, log, reply: plan.reply };
}

describe("docs/voice-action-fixtures.json", () => {
  it.each(corpus.reads)("reads a screen digest as the backend does", (entry) => {
    const raw = entry.screen ? corpus.screens[entry.screen] : entry.raw;
    expect(readScreen(JSON.stringify(raw))).toEqual(entry.read);
  });

  it("refuses what is no digest", () => {
    expect(readScreen("")).toBeNull();
    expect(readScreen("not json")).toBeNull();
    expect(readScreen("[1]")).toBeNull();
    expect(readScreen("x".repeat(MAX_SCREEN_BYTES + 1))).toBeNull();
  });

  it.each(corpus.texts)("offers the words to type of $said", ({ said, candidates }) => {
    expect(textCandidates(said)).toEqual(candidates);
  });

  it.each(corpus.decisions)("decides $name", (entry) => {
    const decision = buildDecision({ scene: entry.scene, scenes: corpus.scenes, screen: screen(entry.screen), transcript: entry.said });
    expect(decision.request).toEqual(entry.request);
    const plan = planFromAnswers(decision, entry.answers as never, { now, transcript: entry.said });
    expect(planJson(plan)).toEqual(entry.plan);
  });

  it.each(corpus.contexts)("tells the chat what is on the $screen screen", (entry) => {
    expect(screenContextBlock(screen(entry.screen), entry.scene)).toEqual(entry.block);
  });

  it.each(corpus.tools)("runs the chat's screen tools for $said", (entry) => {
    const box = new VoiceScreenTools(screen(entry.screen), entry.scene, { now, transcript: entry.said });
    for (const [tool, args, result] of entry.calls) {
      expect(box.call(tool, args)).toEqual(result);
    }
    expect(box.events).toEqual(entry.events);
  });
});

describe("voice actions", () => {
  it("hands a failed Jev call to the chat", async () => {
    const entry = corpus.decisions[0]!;
    const outcome = await decideVoiceAction({
      ask: async () => {
        throw new JevError("Jev refused (503)");
      },
      now,
      scene: entry.scene,
      scenes: corpus.scenes,
      screen: screen(entry.screen),
      transcript: entry.said,
    });
    expect(outcome.plan).toBeNull();
    expect(outcome.error).toContain("503");
  });

  it("reads custom events' voice declarations as the backend does", () => {
    const { events, fallback } = sceneVoiceEvents({
      customEvents: [
        { name: "nextPage" },
        { aliases: ["update", 3, " "], description: "Fetch the news again", name: "refresh" },
        { description: "Not for voice", name: "secret", voice: "never" },
        { description: "Save a memo", name: "memo", voice: "fallback" },
        { description: "Another", name: "memo2", voice: "fallback" },
      ],
    });
    expect(events).toEqual([{ aliases: ["update"], description: "Fetch the news again", name: "refresh" }]);
    expect(fallback).toEqual({ aliases: [], description: "Save a memo", name: "memo" });
  });
});
