// Voice actions (docs/voice-chat.md "Voice actions"): what was said at the
// frame's voice key, matched to what the frame can do right now, and done by
// the frame itself without a chat turn.
//
// The frame sends a screen digest before its audio (frameos/voice_screen.nim:
// the elements of the scene's UIs a tap, a field or a scroll reaches, whether
// the keyboard is up, the windows beside it, the scene's state). The plane adds
// what it holds of the scene (its custom events with their `description`,
// `aliases` and `voice` role, docs/events.md) and of the frame (its other
// scenes), and asks TypeSafe's Jev, a decision model, ONE request of typed
// questions: which kind of thing was asked, which element, which custom event,
// which scene, which exact words to type, whether to send them. A sure answer
// becomes the events the frame dispatches from the origin `voice` (`uiAction`,
// a custom event, `setCurrentScene`), carried back in the reply; "several
// things", "something else" or an unsure answer goes to the voice chat
// (voice.ts), which gets the same screen as tools (`press`, `type_text`,
// `scene_action`) and steers.
//
// The backend's copy is backend/app/utils/voice_actions.py; both replay
// docs/voice-action-fixtures.json, which pins the request each builds and the
// plan each makes of Jev's answers.
import type { ResponsesToolDefinition } from "./openai";
import type { JsonObject } from "./scene-utils";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 8000;

export const MAX_SCREEN_BYTES = 32 * 1024;
const MAX_SCREEN_TARGETS = 64;
const MAX_TARGET_TEXT = 160;
const MAX_OPTIONS = 64;
const MAX_TEXT_CANDIDATES = 6;
const MAX_EVENT_TEXT = 1000;

const MIN_KIND_PROBABILITY = 0.45;
const MIN_TARGET_PROBABILITY = 0.35;
const SUBMIT_PROBABILITY = 0.5;
const DICTATION_SUBMIT_PROBABILITY = 0.8;
const REPLACE_PROBABILITY = 0.5;

export const KIND_TYPE = "type";
export const KIND_ENTER = "enter";
export const KIND_FILL = "fill";
export const KIND_PRESS = "press";
export const KIND_ACTION = "action";
export const KIND_SWITCH = "switch";
export const KIND_SEVERAL = "several";
export const KIND_OTHER = "other";
export const KIND_FALLBACK = "fallback";

const KIND_DESCRIPTIONS: Record<string, string> = {
  [KIND_TYPE]: "Dictating: the words are to be typed into the text field that has the keyboard",
  [KIND_ENTER]: "Press Enter in the text field that has the keyboard: send it, add it, done, that's it",
  [KIND_FILL]: "Put words into a text field on the screen: add an item by typing it in, or change what a field says",
  [KIND_PRESS]: "Press something on the screen: a button, an icon, a checkbox, an item in a list",
  [KIND_ACTION]: "One of the scene's own actions",
  [KIND_SWITCH]: "Show another scene or app, or bring an open window to the front",
  [KIND_SEVERAL]: "Several different things to do in one request (two items to add, or a change and then a switch)",
  [KIND_OTHER]:
    "Something else: a question, making a new scene or picture, a setting of the frame or of the scene, " +
    "or nothing on this screen fits",
};

const QUESTION_KIND = "What does the person want the frame to do with what they said?";
const QUESTION_PRESS = "Which element on the screen should be pressed to do what they asked?";
const QUESTION_FIELD = "Which text field should the words go into?";
const QUESTION_ACTION = "Which of the scene's actions did they ask for?";
const QUESTION_SWITCH = "Which scene or window should the frame show?";
const QUESTION_WORDS =
  "Exactly which words should be typed into the field? Leave out command words (add, type, write, put) " +
  "and where to put them (to the list, into the field).";
const QUESTION_SUBMIT =
  "Should the words be entered right away, as pressing Enter does: an item added to a list, a message sent, a " +
  "search run? Yes when they asked to add, send, save, search or enter something; no when they are only " +
  "dictating words into a field to go on editing.";
const NONE_OPTION = "none";
const NONE_WORDS = "None of these";
const QUESTION_REPLACE =
  "Should what the field says now be replaced by the new words (renaming or correcting it), rather than added to?";

type VoiceEventOption = { name: string; description: string; aliases: string[] };
const BACK_ACTION: VoiceEventOption = {
  aliases: ["previous page"],
  description: "Go back: the previous page, photo or step",
  name: "back",
};
const FORWARD_ACTION: VoiceEventOption = {
  aliases: ["next page"],
  description: "Go forward: the next page, photo or step",
  name: "forward",
};

export const VOICE_ACTION_TOOL = "voice_action";
const REPLY_TYPED = "Typed “{text}”.";
const REPLY_ADDED = "Added “{text}”.";
const REPLY_PRESSED = "Pressed {what}.";
const REPLY_ACTION = "{what}.";
const REPLY_SWITCHED = "Showing {what}.";

export type ScreenTarget = {
  id: string;
  do: "tap" | "type" | "pick" | "scroll";
  text?: string;
  label?: string;
  near?: string;
  focus?: true;
  lines?: true;
  number?: true;
  scroll?: true;
};
export type VoiceScreen = {
  v: 1;
  scene: string;
  kb: boolean;
  targets: ScreenTarget[];
  open?: string[];
  state?: JsonObject;
};
export type VoiceDeviceEvent = { name: string; payload: JsonObject };
export type VoiceActionPlan = {
  kind: string;
  events: VoiceDeviceEvent[];
  reply: string;
  log: JsonObject;
  tools: string[];
};
export type VoiceDecision = {
  request: JsonObject;
  targets: Record<string, ScreenTarget>;
  actions: Record<string, VoiceEventOption>;
  scenes: Record<string, { id: string; name: string }>;
  words: Record<string, string>;
  fallback: VoiceEventOption | null;
};
export type VoiceSceneRef = { id: string; name?: string | null };

const format = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

function clip(value: unknown, limit = MAX_TARGET_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** The frame's screen digest, its shape checked and its texts cut: what a
 * frame says is data, never instructions. null for anything that is not one. */
export function readScreen(raw: string | Uint8Array | null | undefined): VoiceScreen | null {
  if (!raw || raw.length === 0 || raw.length > MAX_SCREEN_BYTES) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || (data as JsonObject).v !== 1) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const screen: VoiceScreen = { kb: record.kb === true, scene: clip(record.scene, 200), targets: [], v: 1 };
  if (Array.isArray(record.open)) {
    screen.open = record.open.filter((item): item is string => typeof item === "string").map((item) => clip(item, 200)).slice(0, 16);
  }
  if (record.state && typeof record.state === "object" && !Array.isArray(record.state)) {
    screen.state = record.state as JsonObject;
  }
  for (const item of Array.isArray(record.t) ? record.t : []) {
    if (screen.targets.length >= MAX_SCREEN_TARGETS) {
      break;
    }
    if (!item || typeof item !== "object" || typeof (item as JsonObject).id !== "string") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (!["tap", "type", "pick", "scroll"].includes(entry.do as string)) {
      continue;
    }
    const target: ScreenTarget = { do: entry.do as ScreenTarget["do"], id: clip(entry.id, 300) };
    for (const key of ["text", "label", "near"] as const) {
      const text = clip(entry[key]);
      if (text) {
        target[key] = text;
      }
    }
    for (const key of ["focus", "lines", "number", "scroll"] as const) {
      if (entry[key] === true) {
        target[key] = true;
      }
    }
    screen.targets.push(target);
  }
  return screen;
}

/** The scene's custom events a spoken request can name (`voice` absent or
 * `match`, with a description or aliases), and its catch-all (`voice:
 * fallback`, the first one). */
export function sceneVoiceEvents(scene: JsonObject | null | undefined): {
  events: VoiceEventOption[];
  fallback: VoiceEventOption | null;
} {
  const events: VoiceEventOption[] = [];
  let fallback: VoiceEventOption | null = null;
  const declared = scene?.customEvents;
  if (!Array.isArray(declared)) {
    return { events, fallback: null };
  }
  for (const entry of declared) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) {
      continue;
    }
    const role = (record.voice as string) || "match";
    const description = clip(record.description, 300);
    const aliases = (Array.isArray(record.aliases) ? record.aliases : [])
      .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      .map((a) => clip(a, 80))
      .slice(0, 12);
    const item = { aliases, description, name: record.name };
    if (role === "fallback") {
      fallback ??= item;
    } else if (role === "match" && (description || aliases.length > 0)) {
      events.push(item);
    }
  }
  return { events, fallback };
}

/** Whether the scene has an event node for `event`, or a JS app that hears it. */
export function sceneListensFor(scene: JsonObject | null | undefined, event: string): boolean {
  if (!scene || typeof scene !== "object") {
    return false;
  }
  for (const node of Array.isArray(scene.nodes) ? scene.nodes : []) {
    const record = node as Record<string, unknown> | null;
    if (record && record.type === "event" && (record.data as JsonObject | undefined)?.keyword === event) {
      return true;
    }
  }
  const apps = scene.apps && typeof scene.apps === "object" ? Object.values(scene.apps as Record<string, unknown>) : [];
  for (const app of apps) {
    const config = ((app as JsonObject | null)?.sources as JsonObject | undefined)?.["config.json"];
    let hears: unknown;
    try {
      hears = typeof config === "string" ? (JSON.parse(config) as JsonObject).events : undefined;
    } catch {
      hears = undefined;
    }
    if (Array.isArray(hears) && (hears.includes(event) || hears.includes("*"))) {
      return true;
    }
  }
  return false;
}

// --------------------------------------------------------------- the words

const LEAD = new RegExp(
  "^(?:(?:please|ok|okay|hey|so|and|then|now)[,]?\\s+)*(?:(?:can|could|would) you\\s+)?" +
    "(?:add|type|write|put|enter|insert|note(?: down)?|jot(?: down)?|create|make)" +
    "(?:\\s+(?:a|an|the|another|one more))?(?:\\s+new)?" +
    "(?:\\s+(?:to-?dos?|todos?|items?|tasks?|entry|entries|notes?|memos?|lines?|reminders?))?" +
    "(?:\\s+(?:called|saying|that says|named|for))?[:,]?\\s+",
  "i",
);
const LEAD_NEW = /^(?:a\s+)?new\s+(?:to-?dos?|todos?|items?|tasks?|entry|notes?|memos?|reminders?)[:,]?\s+/i;
const LEAD_SELF = /^(?:please\s+)?(?:remind me to|i need to|i have to|i must|don't forget to|do not forget to)\s+/i;
const TAIL =
  /\s+(?:to|on|onto|in|into|at)\s+(?:the\s+|my\s+|this\s+)?(?:[\w-]+\s+){0,2}(?:list|field|box|to-?dos?|todos?|notes?|input|form)$/i;
const RENAME = /^(?:please\s+)?(?:rename|change|correct|replace)\s+.+?\s+(?:to|with|into)\s+(.+)$/i;
const QUOTED = /["“‘']([^"”’']{1,200})["”’']/g;

function tidy(text: string): string {
  let out = text.trim().replace(/^[,;:]+|[,;:]+$/g, "").trim();
  if (out.endsWith(".") && !out.endsWith("..") && out.split(".").length - 1 === 1) {
    out = out.slice(0, -1).trimEnd();
  }
  return out;
}

const capital = (text: string) => (text ? text.slice(0, 1).toUpperCase() + text.slice(1) : text);

/** What the words to type could be: the whole utterance, and what is left of
 * it without command words in front and a place behind, a rename's new name,
 * a quoted part. The first is always the utterance itself, tidied. */
export function textCandidates(transcript: string): string[] {
  const said = tidy(transcript);
  const out: string[] = [];
  const add = (value: string) => {
    const text = tidy(value);
    if (text && !out.includes(text) && out.length < MAX_TEXT_CANDIDATES) {
      out.push(text);
    }
  };
  add(said);
  const renamed = RENAME.exec(said);
  if (renamed) {
    add(capital(renamed[1]!));
  }
  for (const quoted of said.matchAll(QUOTED)) {
    add(quoted[1]!);
  }
  let stripped = said.replace(LEAD, "");
  if (stripped === said) {
    stripped = said.replace(LEAD_NEW, "");
  }
  if (stripped === said) {
    stripped = said.replace(LEAD_SELF, "");
  }
  if (stripped !== said) {
    add(capital(stripped));
    const tail = stripped.replace(TAIL, "");
    if (tail !== stripped) {
      add(capital(tail));
    }
  }
  const tailOnly = said.replace(TAIL, "");
  if (tailOnly !== said) {
    add(tailOnly);
  }
  return out;
}

// --------------------------------------------------------------- the request

function targetWords(target: ScreenTarget): string {
  const label = target.label ?? "";
  const text = target.text ?? "";
  let words: string;
  if (target.do === "type") {
    words = label ? `Text field “${label}”` : "Text field";
    if (text) {
      words += ` that says “${text}”`;
    }
    if (target.focus) {
      words += " (it has the keyboard)";
    }
  } else {
    const what = label || text || "Unlabelled button";
    words = what !== "Unlabelled button" ? `“${what}”` : what;
    if (label && text && text !== label) {
      words += ` (shows “${text}”)`;
    }
    if (target.do === "pick") {
      words += " (a list to pick from)";
    }
  }
  if (target.near) {
    words += `, on the row “${target.near}”`;
  }
  return words;
}

function eventWords(event: VoiceEventOption): string {
  let words = event.description || event.name;
  if (event.aliases.length > 0) {
    words += ` (also said as: ${event.aliases.join(", ")})`;
  }
  return words;
}

const choice = (instructions: string, criteria: Record<string, string>) => ({ criteria, instructions, type: "choice" });

/** The Jev request for what was said on this screen. */
export function buildDecision({
  transcript,
  screen,
  scene,
  scenes,
  model = JEV_MODEL,
}: {
  transcript: string;
  screen: VoiceScreen;
  scene: JsonObject | null | undefined;
  scenes: VoiceSceneRef[];
  model?: string;
}): VoiceDecision {
  const targets = screen.targets ?? [];
  const presses = targets.filter((t) => t.do === "tap" || t.do === "pick").slice(0, MAX_OPTIONS);
  const fields = targets.filter((t) => t.do === "type").slice(0, MAX_OPTIONS);
  const focused = fields.find((t) => t.focus) ?? null;
  const { events, fallback } = sceneVoiceEvents(scene);
  let actions = [...events];
  if (sceneListensFor(scene, "back")) {
    actions.push(BACK_ACTION);
  }
  if (sceneListensFor(scene, "forward")) {
    actions.push(FORWARD_ACTION);
  }
  actions = actions.slice(0, MAX_OPTIONS);
  const showing = screen.scene;
  const openWindows = screen.open ?? [];
  const others = scenes.filter((s) => s.id !== showing).slice(0, MAX_OPTIONS);

  const decision: VoiceDecision = { actions: {}, fallback, request: {}, scenes: {}, targets: {}, words: {} };
  const kinds: Record<string, string> = {};
  if (screen.kb && focused) {
    kinds[KIND_TYPE] = KIND_DESCRIPTIONS[KIND_TYPE]!;
    kinds[KIND_ENTER] = KIND_DESCRIPTIONS[KIND_ENTER]!;
  }
  if (fields.length > 0) {
    kinds[KIND_FILL] = KIND_DESCRIPTIONS[KIND_FILL]!;
  }
  if (presses.length > 0) {
    kinds[KIND_PRESS] = KIND_DESCRIPTIONS[KIND_PRESS]!;
  }
  if (actions.length > 0) {
    kinds[KIND_ACTION] = `${KIND_DESCRIPTIONS[KIND_ACTION]}: ${actions.map(eventWords).join("; ")}`;
  }
  if (others.length > 0) {
    kinds[KIND_SWITCH] = KIND_DESCRIPTIONS[KIND_SWITCH]!;
  }
  kinds[KIND_SEVERAL] = KIND_DESCRIPTIONS[KIND_SEVERAL]!;
  kinds[KIND_OTHER] = KIND_DESCRIPTIONS[KIND_OTHER]!;
  if (fallback) {
    kinds[KIND_FALLBACK] = `None of the above fits, so: ${eventWords(fallback)}`;
  }

  const questions: JsonObject = { kind: choice(QUESTION_KIND, kinds) };
  if (presses.length > 1) {
    const criteria: Record<string, string> = {};
    presses.forEach((target, i) => {
      decision.targets[`p${i}`] = target;
      criteria[`p${i}`] = targetWords(target);
    });
    criteria[NONE_OPTION] = NONE_WORDS;
    questions.press = choice(QUESTION_PRESS, criteria);
  } else if (presses.length === 1) {
    decision.targets.p0 = presses[0]!;
    questions.press = choice(QUESTION_PRESS, { p0: targetWords(presses[0]!), [NONE_OPTION]: NONE_WORDS });
  }
  if (fields.length > 1) {
    const criteria: Record<string, string> = {};
    fields.forEach((target, i) => {
      decision.targets[`f${i}`] = target;
      criteria[`f${i}`] = targetWords(target);
    });
    criteria[NONE_OPTION] = NONE_WORDS;
    questions.field = choice(QUESTION_FIELD, criteria);
  } else if (fields.length === 1) {
    decision.targets.f0 = fields[0]!;
    questions.field = choice(QUESTION_FIELD, { f0: targetWords(fields[0]!), [NONE_OPTION]: NONE_WORDS });
  }
  if (actions.length > 1) {
    const criteria: Record<string, string> = {};
    actions.forEach((action, i) => {
      decision.actions[`a${i}`] = action;
      criteria[`a${i}`] = eventWords(action);
    });
    criteria[NONE_OPTION] = NONE_WORDS;
    questions.action = choice(QUESTION_ACTION, criteria);
  } else if (actions.length === 1) {
    decision.actions.a0 = actions[0]!;
    questions.action = choice(QUESTION_ACTION, { a0: eventWords(actions[0]!), [NONE_OPTION]: NONE_WORDS });
  }
  if (others.length > 1) {
    const criteria: Record<string, string> = {};
    others.forEach((other, i) => {
      const name = String(other.name || other.id);
      decision.scenes[`s${i}`] = { id: other.id, name };
      criteria[`s${i}`] = name + (openWindows.includes(other.id) ? " (open in a window)" : "");
    });
    criteria[NONE_OPTION] = NONE_WORDS;
    questions.scene = choice(QUESTION_SWITCH, criteria);
  } else if (others.length === 1) {
    decision.scenes.s0 = { id: others[0]!.id, name: String(others[0]!.name || others[0]!.id) };
    questions.scene = choice(QUESTION_SWITCH, { s0: decision.scenes.s0.name, [NONE_OPTION]: NONE_WORDS });
  }
  if (fields.length > 0) {
    const candidates = textCandidates(transcript);
    candidates.forEach((text, i) => {
      decision.words[`w${i}`] = text;
    });
    if (candidates.length > 1) {
      questions.words = choice(
        QUESTION_WORDS,
        Object.fromEntries(candidates.map((text, i) => [`w${i}`, `“${text}”`])),
      );
    }
    questions.submit = { instructions: QUESTION_SUBMIT, type: "noul" };
    if (fields.some((t) => t.text)) {
      questions.replace = { instructions: QUESTION_REPLACE, type: "noul" };
    }
  }

  const state: JsonObject = { said: transcript };
  const current = scenes.find((s) => s.id === showing) ?? null;
  if (current || scene) {
    state.scene = String((current ?? scene ?? {}).name || showing || "");
  }
  state.keyboard = screen.kb ? "up" : "down";
  state.screen = targets.slice(0, MAX_OPTIONS).map(targetWords);
  decision.request = { model, questions, state };
  return decision;
}

// ----------------------------------------------------------------- the plan

type Answers = Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number } | null>;

function pick<T>(answers: Answers, question: string, options: Record<string, T>): [string | null, number] {
  if (!(question in answers)) {
    const keys = Object.keys(options);
    return keys.length === 1 ? [keys[0]!, 1] : [null, 0];
  }
  const answer = answers[question] ?? {};
  const chosen = answer.choice;
  const probability = typeof chosen === "string" ? Number(answer.probabilities?.[chosen] ?? 0) : 0;
  return [typeof chosen === "string" && chosen in options ? chosen : null, probability];
}

function noul(answers: Answers, question: string): number {
  const value = answers[question]?.noul;
  return typeof value === "number" ? value : 0;
}

function at(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

function what(target: ScreenTarget): string {
  const said = target.label || target.text || "it";
  return `“${said}”` + (target.near ? ` on “${target.near}”` : "");
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** What Jev's answers make the frame do, or null when the chat should decide. */
export function planFromAnswers(
  decision: VoiceDecision,
  answers: Answers,
  { transcript, now }: { transcript: string; now: Date },
): VoiceActionPlan | null {
  const kinds = ((decision.request.questions as JsonObject).kind as { criteria: Record<string, string> }).criteria;
  const [kind, sure] = pick(answers, "kind", kinds);
  const log: JsonObject = { kind, p: round3(sure) };
  if (kind === null || kind === KIND_SEVERAL || kind === KIND_OTHER || sure < MIN_KIND_PROBABILITY) {
    return null;
  }
  const said = transcript.trim().slice(0, MAX_EVENT_TEXT);
  const plan = (events: VoiceDeviceEvent[], reply: string): VoiceActionPlan => ({
    events,
    kind,
    log,
    reply,
    tools: [VOICE_ACTION_TOOL],
  });

  if (kind === KIND_TYPE || kind === KIND_ENTER) {
    const target = Object.values(decision.targets).find((t) => t.do === "type" && t.focus);
    if (!target) {
      return null;
    }
    if (kind === KIND_ENTER) {
      Object.assign(log, { submit: true, target: target.id });
      return plan(
        [{ name: "uiAction", payload: { do: "type", submit: true, target: target.id, text: "" } }],
        format(REPLY_PRESSED, { what: "Enter" }),
      );
    }
    const [wordKey] = pick(answers, "words", decision.words);
    const text = decision.words[wordKey ?? "w0"] ?? "";
    if (!text) {
      return null;
    }
    const submit = noul(answers, "submit") >= DICTATION_SUBMIT_PROBABILITY;
    const typed = target.text && !target.text.endsWith(" ") ? ` ${text}` : text;
    const payload: JsonObject = { do: "type", target: target.id, text: typed };
    if (submit) {
      payload.submit = true;
    }
    Object.assign(log, { submit, target: target.id, text });
    return plan([{ name: "uiAction", payload }], format(submit ? REPLY_ADDED : REPLY_TYPED, { text }));
  }

  if (kind === KIND_FILL) {
    const fields = Object.fromEntries(Object.entries(decision.targets).filter(([key]) => key.startsWith("f")));
    const [key, targetP] = pick(answers, "field", fields);
    const target = key ? fields[key] : undefined;
    const [wordKey] = pick(answers, "words", decision.words);
    const text = decision.words[wordKey ?? "w0"] ?? "";
    if (!target || targetP < MIN_TARGET_PROBABILITY || !text) {
      return null;
    }
    const submit = noul(answers, "submit") >= SUBMIT_PROBABILITY;
    const replace = Boolean(target.text) && noul(answers, "replace") >= REPLACE_PROBABILITY;
    const payload: JsonObject = { do: replace ? "set" : "type", target: target.id, text };
    if (submit) {
      payload.submit = true;
    }
    Object.assign(log, { replace, submit, target: target.id, text });
    return plan([{ name: "uiAction", payload }], format(submit ? REPLY_ADDED : REPLY_TYPED, { text }));
  }

  if (kind === KIND_PRESS) {
    const presses = Object.fromEntries(Object.entries(decision.targets).filter(([key]) => key.startsWith("p")));
    const [key, targetP] = pick(answers, "press", presses);
    if (key === null || targetP < MIN_TARGET_PROBABILITY) {
      return null;
    }
    const target = presses[key]!;
    Object.assign(log, { target: target.id, targetP: round3(targetP) });
    return plan([{ name: "uiAction", payload: { target: target.id } }], format(REPLY_PRESSED, { what: what(target) }));
  }

  if (kind === KIND_ACTION || kind === KIND_FALLBACK) {
    let action: VoiceEventOption | null | undefined;
    let targetP = 1;
    if (kind === KIND_FALLBACK) {
      action = decision.fallback;
    } else {
      const [key, p] = pick(answers, "action", decision.actions);
      action = key ? decision.actions[key] : null;
      targetP = p;
    }
    if (!action || targetP < MIN_TARGET_PROBABILITY) {
      return null;
    }
    const name = action.name;
    const payload: JsonObject = name === "back" || name === "forward" ? {} : { at: at(now), text: said };
    log.event = name;
    return plan(
      [{ name, payload }],
      format(REPLY_ACTION, { what: (action.description || name).replace(/\.+$/, "") }),
    );
  }

  if (kind === KIND_SWITCH) {
    const [key, targetP] = pick(answers, "scene", decision.scenes);
    if (key === null || targetP < MIN_TARGET_PROBABILITY) {
      return null;
    }
    const chosen = decision.scenes[key]!;
    log.scene = chosen.id;
    return plan(
      [{ name: "setCurrentScene", payload: { sceneId: chosen.id } }],
      format(REPLY_SWITCHED, { what: chosen.name }),
    );
  }
  return null;
}

// ------------------------------------------------------------------ asking

export class JevError extends Error {}

/** Jev's answers ({question: answer}); throws JevError when it refused. */
export async function askJev(
  request: JsonObject,
  { apiKey, fetchImpl = fetch }: { apiKey: string; fetchImpl?: typeof fetch },
): Promise<Answers> {
  let response: Response;
  try {
    response = await fetchImpl(JEV_URL, {
      body: JSON.stringify(request),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    throw new JevError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    throw new JevError(`Jev refused (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const payload = (await response.json()) as JsonObject;
  if (!payload || typeof payload.answers !== "object" || payload.answers === null) {
    throw new JevError("Jev answered without answers");
  }
  return payload.answers as Answers;
}

export type VoiceDecisionOutcome = {
  plan: VoiceActionPlan | null;
  decision: VoiceDecision;
  answers: Answers | null;
  ms: number;
  error?: string;
};

/** One utterance on one screen: the request, Jev's answers, the plan (null for
 * the chat). A refused or failed Jev call is the chat's too. */
export async function decideVoiceAction({
  transcript,
  screen,
  scene,
  scenes,
  ask,
  now = new Date(),
}: {
  transcript: string;
  screen: VoiceScreen;
  scene: JsonObject | null | undefined;
  scenes: VoiceSceneRef[];
  ask: (request: JsonObject) => Promise<Answers>;
  now?: Date;
}): Promise<VoiceDecisionOutcome> {
  const decision = buildDecision({ scene, scenes, screen, transcript });
  const started = Date.now();
  let answers: Answers;
  try {
    answers = await ask(decision.request);
  } catch (error) {
    return {
      answers: null,
      decision,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      ms: Date.now() - started,
      plan: null,
    };
  }
  return { answers, decision, ms: Date.now() - started, plan: planFromAnswers(decision, answers, { now, transcript }) };
}

// ------------------------------------------------------- the chat's tools

export const screenToolDefinitions: ResponsesToolDefinition[] = [
  {
    description:
      "Press an element on the frame's screen, as a finger would: a button, an icon, a checkbox, an item. " +
      'By its id from the context\'s "On the screen" list.',
    name: "press",
    parameters: {
      additionalProperties: false,
      properties: { target: { description: "The element's id.", type: "string" } },
      required: ["target"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      'Type words into a text field on the frame\'s screen, by its id from the context\'s "On the screen" ' +
      "list: at the end of what it says, or replacing it; with submit, Enter after (an item added, a form sent).",
    name: "type_text",
    parameters: {
      additionalProperties: false,
      properties: {
        replace: { description: "Replace what the field says instead of adding to it.", type: "boolean" },
        submit: { description: "Press Enter after the words.", type: "boolean" },
        target: { description: "The field's id.", type: "string" },
        text: { description: "The words to type, exactly.", type: "string" },
      },
      required: ["target", "text"],
      type: "object",
    },
    type: "function",
  },
  {
    description:
      'Do one of the showing scene\'s own actions (the context\'s "Scene actions"), by name. What was said ' +
      "goes with it as its text, unless text says otherwise.",
    name: "scene_action",
    parameters: {
      additionalProperties: false,
      properties: {
        name: { description: "The action's name.", type: "string" },
        text: { description: "The text it gets. Omit for what was said.", type: "string" },
      },
      required: ["name"],
      type: "object",
    },
    type: "function",
  },
];
export const screenToolLabels: Record<string, string> = {
  press: "Press",
  scene_action: "Scene action",
  type_text: "Type text",
};
const MAX_SCREEN_EVENTS = 8;

function sceneActions(scene: JsonObject | null | undefined): VoiceEventOption[] {
  const { events, fallback } = sceneVoiceEvents(scene);
  const actions = [...events, ...(fallback ? [fallback] : [])];
  if (sceneListensFor(scene, "back")) {
    actions.push(BACK_ACTION);
  }
  if (sceneListensFor(scene, "forward")) {
    actions.push(FORWARD_ACTION);
  }
  return actions;
}

/** What the chat is told of the screen: each element with the id its tools
 * take, the keyboard, the scene's actions. */
export function screenContextBlock(screen: VoiceScreen, scene: JsonObject | null | undefined): string {
  const lines = ["On the screen (press and type_text take these ids):"];
  for (const target of screen.targets ?? []) {
    lines.push(`- ${target.id}: ${targetWords(target)}` + (target.scroll ? " (scrolls)" : ""));
  }
  if (lines.length === 1) {
    lines.push("- nothing to press or type into");
  }
  lines.push(`The on-screen keyboard is ${screen.kb ? "up" : "down"}.`);
  const actions = sceneActions(scene);
  if (actions.length > 0) {
    lines.push("Scene actions (scene_action takes these names):");
    for (const action of actions) {
      lines.push(`- ${action.name}: ${eventWords(action)}`);
    }
  }
  return lines.join("\n");
}

/** press / type_text / scene_action for the voice chat: each call adds the
 * event the frame will dispatch to `events`, sent back in the reply. */
export class VoiceScreenTools {
  readonly events: VoiceDeviceEvent[] = [];
  private readonly actions: Set<string>;
  transcript: string;
  constructor(
    readonly screen: VoiceScreen,
    readonly scene: JsonObject | null | undefined,
    { transcript = "", now = new Date() }: { transcript?: string; now?: Date } = {},
  ) {
    this.transcript = transcript;
    this.now = now;
    this.actions = new Set(sceneActions(scene).map((a) => a.name));
  }
  private readonly now: Date;

  private target(id: unknown): ScreenTarget | undefined {
    return (this.screen.targets ?? []).find((t) => t.id === id);
  }

  call(name: string, args: JsonObject): JsonObject {
    if (this.events.length >= MAX_SCREEN_EVENTS) {
      return { error: "too_many_actions", ok: false };
    }
    if (name === "press") {
      const target = this.target(args.target);
      if (!target || !["tap", "pick", "type"].includes(target.do)) {
        return { error: "unknown_target", ok: false };
      }
      this.events.push({ name: "uiAction", payload: { target: target.id } });
      return { ok: true, pressed: what(target) };
    }
    if (name === "type_text") {
      const target = this.target(args.target);
      const text = args.text;
      if (!target || target.do !== "type") {
        return { error: "unknown_field", ok: false };
      }
      if (typeof text !== "string" || !text.trim()) {
        return { error: "text must say what to type", ok: false };
      }
      const payload: JsonObject = {
        do: args.replace === true ? "set" : "type",
        target: target.id,
        text: text.trim().slice(0, MAX_EVENT_TEXT),
      };
      if (args.submit === true) {
        payload.submit = true;
      }
      this.events.push({ name: "uiAction", payload });
      return { ok: true, typed: payload.text };
    }
    if (name === "scene_action") {
      const action = args.name;
      if (typeof action !== "string" || !this.actions.has(action)) {
        return { actions: [...this.actions].sort(), error: "unknown_action", ok: false };
      }
      let payload: JsonObject = {};
      if (action !== "back" && action !== "forward") {
        const text = typeof args.text === "string" && args.text.trim() ? args.text : this.transcript;
        payload = { at: at(this.now), text: text.trim().slice(0, MAX_EVENT_TEXT) };
      }
      this.events.push({ name: action, payload });
      return { action, ok: true };
    }
    return { error: `unknown tool ${name}`, ok: false };
  }
}
