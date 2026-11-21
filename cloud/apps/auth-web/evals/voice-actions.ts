// Voice actions eval (docs/voice-chat.md "Voice actions"): many utterances on
// the real screen digests of docs/voice-action-fixtures.json (the To-do, with
// and without the keyboard, Voice memos, a desktop with windows), each with
// what it should do, decided by the real Jev through voice-actions.ts. Reports
// the accuracy per kind and Jev's latency; with --speech, also the
// transcription's, on speech made by OpenAI's TTS (what the frame would send).
//
//   TYPESAFE_API_KEY=... [OPENAI_API_KEY=...] pnpm --filter @frameos-cloud/auth-web ai:eval:voice [--speech] [--repeat N]
//
// Writes evals/results/voice-actions-<time>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import type { JsonObject } from "../src/lib/ai/scene-utils";
import { askJev, decideVoiceAction, readScreen, type VoiceScreen } from "../src/lib/ai/voice-actions";

type Expect =
  | { chat: true }
  | { tap: string } // the target's label/text, and the row it is on after "@"
  | { type: string; text: string; submit?: boolean; replace?: boolean } // field label/text, the words
  | { enter: true }
  | { event: string }
  | { scene: string };

const corpus = JSON.parse(
  readFileSync(resolve(here, "../../../../docs/voice-action-fixtures.json"), "utf8"),
) as { scenes: { id: string; name: string }[]; screens: Record<string, JsonObject>; decisions: { screen: string; scene: JsonObject | null }[] };
const sceneOf = (screen: string) => corpus.decisions.find((d) => d.screen === screen)?.scene ?? null;

const CASES: [string, string, Expect][] = [
  // The To-do, keyboard down.
  ["to-do", "Add milk.", { submit: true, text: "Milk", type: "Add a to-do" }],
  ["to-do", "Add bananas to the list.", { submit: true, text: "Bananas", type: "Add a to-do" }],
  ["to-do", "Put call the plumber on the list.", { submit: true, text: "Call the plumber", type: "Add a to-do" }],
  ["to-do", "New to-do: water the garden.", { submit: true, text: "Water the garden", type: "Add a to-do" }],
  ["to-do", "Remind me to pay rent.", { submit: true, text: "Pay rent", type: "Add a to-do" }],
  ["to-do", "I need to buy stamps.", { submit: true, text: "Buy stamps", type: "Add a to-do" }],
  ["to-do", "Mark the dentist as done.", { tap: "Mark done@Book the dentist" }],
  ["to-do", "Tick off the recycling.", { tap: "Mark done@Take the recycling out" }],
  ["to-do", "I called grandma.", { tap: "Mark done@Call grandma about Sunday" }],
  ["to-do", "Check off the bike light.", { tap: "Mark done@Fix the bike light" }],
  ["to-do", "The plants aren't watered after all.", { tap: "Mark not done@Water the plants" }],
  ["to-do", "Uncheck water the plants.", { tap: "Mark not done@Water the plants" }],
  ["to-do", "Delete the bike light one.", { tap: "Delete@Fix the bike light" }],
  ["to-do", "Remove the oat milk item.", { tap: "Delete@Oat milk, coffee beans, lemons" }],
  ["to-do", "Get rid of the recycling task.", { tap: "Delete@Take the recycling out" }],
  ["to-do", "Rename book the dentist to call the dentist.", { replace: true, text: "Call the dentist", type: "Book the dentist" }],
  ["to-do", "Change fix the bike light to fix the bike brakes.", { replace: true, text: "Fix the bike brakes", type: "Fix the bike light" }],
  ["to-do", "Press add.", { tap: "Add" }],
  ["to-do", "Show me the calendar.", { scene: "Calendar" }],
  ["to-do", "Switch to the clock.", { scene: "Clock" }],
  ["to-do", "Open voice memos.", { scene: "Voice memos" }],
  ["to-do", "What's the weather like?", { chat: true }],
  ["to-do", "Add eggs and bread.", { chat: true }],
  ["to-do", "Tick off the dentist and the recycling.", { chat: true }],
  ["to-do", "Make me a scene with a countdown to Christmas.", { chat: true }],
  ["to-do", "Rotate the frame.", { chat: true }],
  ["to-do", "Tick off the plumber.", { chat: true }],
  ["to-do", "Delete the swimming lesson.", { chat: true }],
  // The To-do with the keyboard up on a row.
  ["to-do-keyboard", "and new brakes too", { text: "and new brakes too", type: "Fix the bike brakes" }],
  ["to-do-keyboard", "Send it.", { enter: true }],
  ["to-do-keyboard", "Done.", { enter: true }],
  ["to-do-keyboard", "Enter.", { enter: true }],
  ["to-do-keyboard", "Delete the dentist.", { chat: true }],
  ["to-do-keyboard", "Show me the clock.", { scene: "Clock" }],
  // Voice memos: what matches nothing is a memo.
  ["voice-memos", "Open the plumber memo.", { tap: "Yesterday 08:15 Call the plumber about the kitchen tap" }],
  ["voice-memos", "Read me the one about oat milk.", { tap: "Today 18:40 Buy oat milk and coffee beans" }],
  ["voice-memos", "Delete the oat milk one.", { tap: "Delete@Today 18:40 Buy oat milk and coffee beans" }],
  ["voice-memos", "Delete yesterday's memo.", { tap: "Delete@Yesterday 08:15 Call the plumber about the kitchen tap" }],
  ["voice-memos", "Remind me to call mom on Sunday.", { event: "voiceMemo" }],
  ["voice-memos", "The wifi password is on the fridge.", { event: "voiceMemo" }],
  ["voice-memos", "Take a note: buy a birthday present for Ana.", { event: "voiceMemo" }],
  ["voice-memos", "Idea for the garden: plant tulips in October.", { event: "voiceMemo" }],
  ["voice-memos", "Next page.", { event: "forward" }],
  ["voice-memos", "Go back.", { event: "back" }],
  ["voice-memos", "Show me my to-do list.", { scene: "To-do" }],
  ["voice-memos", "What's the time in Tokyo?", { chat: true }],
  // A desktop with windows.
  ["desktop", "Bring the to-do list to the front.", { scene: "To-do" }],
  ["desktop", "Focus the clock window.", { scene: "Clock" }],
  ["desktop", "Open the weather.", { scene: "Weather" }],
  ["desktop", "Go to next month.", { tap: "Next month" }],
  ["desktop", "Previous month.", { tap: "Previous month" }],
  ["desktop", "Jump to today.", { tap: "Today" }],
  ["desktop", "Close this window.", { tap: "Close@Calendar" }],
  ["desktop", "Open the start menu.", { tap: "Start" }],
];

function judge(screen: VoiceScreen, expect: Expect, events: { name: string; payload: JsonObject }[] | null): boolean {
  if ("chat" in expect) return events === null;
  if (!events || events.length !== 1) return false;
  const [event] = events as [{ name: string; payload: JsonObject }];
  const target = screen.targets.find((t) => t.id === event.payload.target);
  if ("tap" in expect) {
    const [what, near] = expect.tap.split("@");
    return event.name === "uiAction" && !event.payload.do && !!target &&
      (target.label === what || target.text === what) && (!near || target.near === near);
  }
  if ("enter" in expect) return event.name === "uiAction" && event.payload.submit === true && event.payload.text === "";
  if ("type" in expect) {
    const text = String(event.payload.text ?? "").trim();
    return event.name === "uiAction" && !!target && (target.label === expect.type || target.text === expect.type) &&
      text.toLowerCase() === expect.text.toLowerCase() &&
      (expect.submit === undefined || (event.payload.submit === true) === expect.submit) &&
      (expect.replace === undefined || (event.payload.do === "set") === expect.replace);
  }
  if ("event" in expect) return event.name === expect.event;
  if ("scene" in expect) {
    const scene = corpus.scenes.find((s) => s.name === expect.scene);
    return event.name === "setCurrentScene" && event.payload.sceneId === scene?.id;
  }
  return false;
}

const kindOf = (expect: Expect) => Object.keys(expect).find((k) => ["chat", "tap", "type", "enter", "event", "scene"].includes(k))!;

async function speechTimings(apiKey: string): Promise<number[]> {
  // What a frame sends: 16 kHz 16-bit mono PCM, here from OpenAI's TTS as a WAV.
  const times: number[] = [];
  for (const words of ["Add milk.", "Mark the dentist as done.", "Remind me to call mom on Sunday."]) {
    const tts = await fetch("https://api.openai.com/v1/audio/speech", {
      body: JSON.stringify({ input: words, model: "gpt-4o-mini-tts", response_format: "wav", voice: "alloy" }),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
    });
    const wav = new Uint8Array(await tts.arrayBuffer());
    const form = new FormData();
    form.set("model", "gpt-4o-mini-transcribe");
    form.set("response_format", "json");
    form.set("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    const started = Date.now();
    const heard = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      body: form,
      headers: { Authorization: `Bearer ${apiKey}` },
      method: "POST",
    });
    await heard.json();
    times.push(Date.now() - started);
  }
  return times;
}

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
  const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1]) || 1;
  const rows: JsonObject[] = [];
  const latencies: number[] = [];
  for (let round = 0; round < repeat; round += 1) {
    await Promise.all(
      CASES.map(async ([screenName, said, expect]) => {
        const screen = readScreen(JSON.stringify(corpus.screens[screenName])) as VoiceScreen;
        const outcome = await decideVoiceAction({
          ask: (request) => askJev(request, { apiKey }),
          scene: sceneOf(screenName),
          scenes: corpus.scenes,
          screen,
          transcript: said,
        });
        latencies.push(outcome.ms);
        const events = outcome.plan?.events ?? null;
        rows.push({ events, expect, kind: kindOf(expect), ms: outcome.ms, ok: judge(screen, expect, events), round, said, screen: screenName, error: outcome.error });
      }),
    );
  }
  const byKind: Record<string, { ok: number; all: number }> = {};
  for (const row of rows) {
    const entry = (byKind[row.kind as string] ??= { all: 0, ok: 0 });
    entry.all += 1;
    entry.ok += row.ok ? 1 : 0;
  }
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  const correct = rows.filter((r) => r.ok).length;
  const report: JsonObject = {
    accuracy: correct / rows.length,
    byKind,
    cases: rows.length,
    jevMs: { max: latencies.at(-1), p50: pct(0.5), p90: pct(0.9) },
    misses: rows.filter((r) => !r.ok).map((r) => ({ events: r.events, expect: r.expect, said: r.said, screen: r.screen })),
  };
  if (process.argv.includes("--speech") && process.env.OPENAI_API_KEY) {
    report.transcriptionMs = await speechTimings(process.env.OPENAI_API_KEY);
  }
  const out = resolve(here, "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, `voice-actions-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ report, rows }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

void main();
