// The eval suite. "create" cases start from an empty editor, "modify" cases
// open a store scene (by slug, from the local database) the way the store's
// editor does. Checks are deliberately about the REQUEST, not one particular
// implementation: an app OR a code node may satisfy "show the date".
//
// Cases needing live third-party data render through the dev server's proxy,
// so a network hiccup can fail render_ok; the judge sees what the user would.
import type { EvalCase } from "../lib/types";

const portrait = { height: 800, width: 480 };
const big = { height: 1200, width: 1600 };

export const cases: EvalCase[] = [
  // ---------------------------------------------------------------- create
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "refresh_interval", max: 300 },
      { type: "judge", min: 3 },
    ],
    id: "create-word-clock",
    judgeRubric:
      "A word clock: a grid of letters (or typeset words) where the words spelling the current time are highlighted/bold, e.g. IT IS HALF PAST NINE. Letters should be large and evenly spaced.",
    prompt:
      "Build a word clock: a grid of capital letters where the words spelling the current time (like IT IS HALF PAST NINE) are highlighted and the rest are faint. Black on white, refresh every 5 minutes.",
    tags: ["create", "clock", "code"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "app_used", keyword: "render/text" },
      { type: "refresh_interval", max: 60 },
      { type: "judge", min: 3 },
    ],
    id: "create-big-clock",
    judgeRubric: "Huge digits filling most of the panel, the date in smaller type beneath, nothing cut off.",
    prompt:
      "A big typographic clock: huge numerals filling the panel, today's date beneath in smaller type. Black on white, for a fast-refresh panel that updates every minute.",
    tags: ["create", "clock"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "any_app_used", keywords: ["render/svg", "repo/apps/code/jsSvg", "jsSvg", "render/text"] },
      { type: "refresh_interval", min: 3600 },
      { type: "judge", min: 3 },
    ],
    id: "create-year-progress",
    judgeRubric:
      "A dot grid representing the days of the year with past days filled and future days hollow (or similar), plus a percentage of the year complete. Grid should fill the panel neatly.",
    prompt:
      "Year progress screen: a dot grid with one dot per day of the year, past days filled and future days hollow, today highlighted, and the percentage of the year complete in big type. Refresh daily.",
    tags: ["create", "svg", "code"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "refresh_interval", min: 3600 },
      { type: "code_nodes_min", min: 1 },
      { type: "app_not_used", keyword: "data/openaiText" },
      { type: "judge", min: 3 },
    ],
    id: "create-quote-of-the-day",
    judgeRubric: "One quotation in large serif-looking type with an attribution line; generous margins; nothing else.",
    prompt:
      "Quote of the day: bundle 20 stoic quotes in a code node, pick one per day, show it in big serif type with the author beneath. No external APIs, no AI. Refresh daily.",
    tags: ["create", "text", "code"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "public_fields_min", min: 2 },
      { type: "json_matches", pattern: "wedding" },
      { type: "judge", min: 3 },
    ],
    id: "create-countdown",
    judgeRubric: "A number of days until an event dominates the screen with the event name; must not be blank or show NaN.",
    prompt:
      "Countdown board: show the number of days until an event in huge type with the event name above it. The event name and date must be scene fields users can change (default: 'Wedding', 2027-06-14). Refresh daily.",
    tags: ["create", "code", "fields"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "json_matches", pattern: "data/downloadUrl|frameos\\.fetch(?:Json|Text)" },
      { type: "public_fields_min", min: 1 },
      { type: "judge", min: 3 },
    ],
    id: "create-rss-headlines",
    judgeRubric: "Several news headlines listed in readable newspaper-like type, with a source or feed title; no raw XML or error text.",
    prompt:
      "News headlines: fetch an RSS feed (default https://feeds.bbci.co.uk/news/rss.xml, make the URL a scene field) and list the top 6 headlines in newspaper-style typography with the feed name as a masthead. Refresh every 30 minutes.",
    settings: {},
    tags: ["create", "data", "network"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "json_matches", pattern: "data/downloadUrl|frameos\\.fetch(?:Json|Text)" },
      { type: "json_matches", pattern: "wiki(?:pedia|media)\\.org" },
      { type: "refresh_interval", min: 3600 },
      { type: "judge", min: 3 },
    ],
    id: "create-on-this-day",
    judgeRubric: "Today's date as a title and a short list of historical events with years; text readable, not overflowing.",
    prompt:
      "On This Day: use the Wikimedia 'On this day' API (https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/MM/DD) to show 5 historical events for today's date with their years. Title with today's date. Refresh daily.",
    tags: ["create", "data", "network"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "json_matches", pattern: "data/downloadUrl|frameos\\.fetch(?:Json|Text)" },
      { type: "json_matches", pattern: "coingecko" },
      { type: "field_exists", name: "coins" },
      { type: "judge", min: 3 },
    ],
    id: "create-crypto-prices",
    judgeRubric: "A short table of coin names with prices and a 24h change; aligned columns; readable.",
    prompt:
      "Crypto price board using the free CoinGecko API (no key): show bitcoin, ethereum and solana with USD price and 24h change, as a clean table. The coin list must be a scene field called 'coins' (comma separated ids). Refresh every 15 minutes.",
    tags: ["create", "data", "network", "fields"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "code_nodes_min", min: 1 },
      { type: "field_exists", name: "latitude" },
      { type: "field_exists", name: "longitude" },
      { type: "app_not_used", keyword: "data/downloadUrl" },
      { type: "judge", min: 3 },
    ],
    id: "create-sun-moon",
    judgeRubric:
      "Sunrise and sunset times, day length, and a moon phase drawn as a disc (partially shaded). Numbers must look plausible (times in HH:MM), no NaN.",
    prompt:
      "Sun & moon panel computed entirely offline from latitude/longitude scene fields (default Brussels 50.85, 4.35): sunrise, sunset, day length, and the current moon phase drawn as a shaded disc with its name. No network requests. Refresh daily.",
    tags: ["create", "code", "svg", "offline"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "json_matches", pattern: "data/downloadUrl|frameos\\.fetch(?:Json|Text)" },
      { type: "json_matches", pattern: "open-meteo" },
      { type: "judge", min: 3 },
    ],
    id: "create-air-quality",
    judgeRubric: "An air quality index number prominently, PM2.5/PM10 values, and a gauge or band indicating the level; readable in grayscale.",
    prompt:
      "Air quality screen using the free Open-Meteo air quality API (no key): show the European AQI as a big number with a text level (good/fair/moderate/poor), PM2.5 and PM10 beneath, and a simple horizontal gauge. Latitude/longitude as scene fields (default Brussels). Refresh hourly.",
    tags: ["create", "data", "network", "svg"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "app_used", keyword: "data/unsplash" },
      { type: "app_used", keyword: "render/text" },
      { type: "app_used", keyword: "render/image" },
    ],
    id: "create-photo-with-date",
    prompt:
      "Full-screen random Unsplash photo of mountains with today's date overlaid in the bottom-right corner in white text with a subtle shadow. Refresh every hour.",
    tags: ["create", "image"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "app_used", keyword: "render/split" },
      { type: "any_app_used", keywords: ["data/weather", "weatherPanel", "repo/apps/code/weatherPanel"] },
      { type: "any_app_used", keywords: ["render/calendar", "data/icalJson", "data/eventsToAgenda"] },
      { type: "judge", min: 3 },
    ],
    frame: big,
    id: "create-split-dashboard",
    judgeRubric: "Two clear halves: a weather forecast on the left and a month calendar on the right, each filling its half without overlap.",
    prompt:
      "Dashboard for a 1600x1200 panel: left half shows the weather forecast for Brussels, right half shows this month's calendar. Use a split layout.",
    tags: ["create", "layout", "big"],
  },
  {
    checks: [
      { type: "delivered", tool: "build_scene" },
      { type: "lint_clean" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "app_used", keyword: "render/svg" },
      { type: "code_nodes_min", min: 1 },
      { type: "refresh_interval", max: 60 },
      { type: "judge", min: 3 },
    ],
    frame: portrait,
    id: "create-analog-clock",
    judgeRubric: "A round analog clock face with hour and minute hands and hour marks, centred on a portrait panel; hands at a plausible time.",
    prompt:
      "Analog clock face drawn as SVG: a round dial with 12 hour marks, hour and minute hands at the current time, a small date beneath the dial. Station-clock style, black on white, refresh every minute. Portrait 480x800 panel.",
    tags: ["create", "svg", "code", "portrait"],
  },

  // ---------------------------------------------------------------- modify
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.8 },
      { type: "preserves_fields" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "json_matches", pattern: "#?(ff0000|f00|red)", flags: "i" },
      { type: "judge", min: 3 },
    ],
    id: "modify-counter-bigger-red",
    judgeRubric: "A single large number in red, much larger than a default 32px text, centred.",
    prompt: "Make the number twice as big and red.",
    seedSlug: "counter",
    tags: ["modify", "text"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.9 },
      { type: "preserves_fields" },
      { type: "field_value", matches: "fahrenheit", name: "temperatureUnit" },
    ],
    id: "modify-weather-fahrenheit",
    prompt: "Show temperatures in Fahrenheit by default.",
    seedSlug: "weather",
    tags: ["modify", "fields"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.95 },
      { type: "preserves_fields" },
      { type: "refresh_interval", max: 1800, min: 1800 },
    ],
    id: "modify-calendar-refresh",
    prompt: "Refresh this every 30 minutes instead of whatever it does now.",
    seedSlug: "calendar",
    tags: ["modify", "settings"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.8 },
      { type: "preserves_fields" },
      { type: "app_used", keyword: "render/text", min: 2 },
      { type: "json_matches", pattern: "title" },
    ],
    id: "modify-xkcd-title",
    prompt: "Add the comic's title above the image in big bold text.",
    seedSlug: "xkcd",
    tags: ["modify", "text", "data"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.7 },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "json_matches", pattern: "picsum\\.photos" },
      { type: "app_used", keyword: "render/text" },
      { type: "judge", min: 3 },
    ],
    id: "modify-image-url-caption",
    judgeRubric: "A photo filling the frame with a short caption overlaid at the bottom.",
    prompt: "Change the image URL to https://picsum.photos/800/480 and add the caption 'Random picture' at the bottom.",
    seedSlug: "image-from-url",
    tags: ["modify", "image", "network"],
  },
  {
    checks: [
      { type: "not_delivered" },
      { type: "reply_matches", pattern: "message" },
      { type: "reply_matches", pattern: "state|field|webhook|event|POST|API", flags: "i" },
    ],
    id: "ask-explain-message-board",
    prompt: "Explain what this scene does and how I would update the message from outside the frame. Don't change anything.",
    seedSlug: "message-board",
    tags: ["ask"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_fields" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "judge", min: 3 },
    ],
    frame: portrait,
    id: "modify-github-stars-portrait",
    judgeRubric: "Content laid out for a tall portrait panel (480x800): nothing squashed or overflowing; the star count and repository name readable.",
    prompt: "Rearrange this for a portrait 480x800 panel: big star count in the middle, repository name above it, everything readable.",
    seedSlug: "github-stars",
    tags: ["modify", "layout", "portrait"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.8 },
      { type: "preserves_fields" },
      { type: "json_matches", pattern: "\"backgroundColor\":\\s*\"#(0|1|2)[0-9a-f]{5}\"", flags: "i" },
    ],
    id: "modify-haiku-dark",
    prompt: "Make the background dark and the text light.",
    seedSlug: "haiku-of-the-hour",
    tags: ["modify", "style"],
  },
  {
    checks: [
      { type: "delivered", tool: "modify_scene" },
      { type: "lint_clean" },
      { type: "preserves_node_ids", minFraction: 0.8 },
      { type: "preserves_fields" },
      { type: "render_ok" },
      { type: "render_not_blank" },
      { type: "any_app_used", keywords: ["data/clock", "render/text"] },
      { type: "judge", min: 3 },
    ],
    id: "modify-weather-add-time",
    judgeRubric: "The weather layout remains, plus a current time readout (HH:MM) placed in a corner without covering the forecast.",
    prompt: "Add the current time in the top-right corner, small, without covering the forecast.",
    seedSlug: "weather",
    tags: ["modify", "layout"],
  },
];

export function selectCases(options: { only?: string[]; filter?: string[] } = {}): EvalCase[] {
  return cases.filter((evalCase) => {
    if (options.only && options.only.length > 0 && !options.only.includes(evalCase.id)) {
      return false;
    }
    if (options.filter && options.filter.length > 0 && !options.filter.some((tag) => evalCase.tags.includes(tag))) {
      return false;
    }
    return true;
  });
}
