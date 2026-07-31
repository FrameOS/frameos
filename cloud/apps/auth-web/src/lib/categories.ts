// The store's category taxonomy: one curated shelf per category on the
// store front, in this order. Scenes carry at most one category
// (store_scenes.category); it is auto-assigned on publish by the classifier
// (store-classify.ts), editable by the owner, and backfillable from
// /admin/scenes. Adding a category here is enough — the homepage, editors,
// and classifier all read this list.

export type StoreCategory = {
  slug: string;
  title: string;
  // Shelf copy on the store front.
  description: string;
  // What belongs here — shown to the classifier, kept blunt on purpose.
  hint: string;
};

export const storeCategories: StoreCategory[] = [
  {
    slug: "photos",
    title: "Photos",
    description:
      "Your own pictures on the frame — albums, slideshows, and photo services like Google Photos or Immich.",
    hint: "displays the user's own photos or photos fetched from a photo service (Google Photos, Immich, Unsplash, SD card, image URLs, slideshows)",
  },
  {
    slug: "art",
    title: "Art & galleries",
    description:
      "Curated image collections that rotate on a schedule, no configuration needed.",
    hint: "a bundled, curated collection of artwork or themed images that ships with the scene and rotates through them",
  },
  {
    slug: "calendar",
    title: "Calendars & agendas",
    description: "Upcoming events and schedules, straight from your calendar.",
    hint: "shows calendar events, agendas, or schedules (iCal, Google Calendar, day planners)",
  },
  {
    slug: "weather",
    title: "Weather",
    description: "Current conditions and forecasts at a glance.",
    hint: "shows weather conditions or forecasts",
  },
  {
    slug: "ai",
    title: "AI & generative",
    description:
      "Scenes that generate fresh images or words with AI on every refresh.",
    hint: "calls a generative AI service (OpenAI, image generation, LLM text) to produce the content it displays",
  },
  {
    slug: "dashboards",
    title: "Data & dashboards",
    description: "Charts, counters and stats from the services you care about.",
    hint: "renders data, charts, metrics, or stats pulled from a service or API (star counts, graphs, dashboards)",
  },
  {
    slug: "fun",
    title: "Fun & comics",
    description: "Comics, games and other things that make you smile.",
    hint: "entertainment: comics, jokes, games, novelty content",
  },
  {
    slug: "utilities",
    title: "Tools & utilities",
    description:
      "Webcams, screenshots, message boards and other practical helpers.",
    hint: "a practical tool: webcam/RTSP feeds, web page screenshots, message boards, hardware buttons, clocks",
  },
  {
    slug: "demos",
    title: "Demos & examples",
    description: "Small demos and building blocks to learn from or remix.",
    hint: "primarily a demo, sample, or building block showing a FrameOS technique rather than a finished scene",
  },
];

const bySlug = new Map(
  storeCategories.map((category) => [category.slug, category]),
);

export function getStoreCategory(slug: string | null | undefined) {
  return slug ? bySlug.get(slug) : undefined;
}

// Normalizes a user-supplied category: a taxonomy slug, or null/"" to clear.
// Returns undefined for anything else (invalid input).
export function normalizeCategory(
  value: unknown,
): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const slug = value.trim().toLowerCase();
  if (slug === "") {
    return null;
  }
  return bySlug.has(slug) ? slug : undefined;
}
