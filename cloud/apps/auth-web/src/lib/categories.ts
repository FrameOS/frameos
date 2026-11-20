// The store's category taxonomy: one curated shelf per category on the
// store front, in this order, scenes' shelves first and layouts' after (the
// store front shows them apart). Scenes carry at most one category
// (store_scenes.category): the one a scene names itself (settings.category),
// else the owner's, else the rules and the classifier's (store-classify.ts),
// editable by the owner and from /admin/scenes. A layout's is its kind.
// Adding a category here is enough — the store front, editors, and
// classifier all read this list; frontend/src/utils/storeCategories.ts is
// the SPA's copy, kept equal by categories.test.ts.

export type StoreCategory = {
  slug: string;
  title: string;
  // Shelf copy on the store front.
  description: string;
  // What belongs here — shown to the classifier, kept blunt on purpose.
  hint: string;
  // What the shelf holds: scenes, or layouts (a scene with settings.isLayout,
  // which wraps the others). A layout's shelf follows from what it is
  // (made for a device, settings.devices; a desktop, settings.desktop; or
  // neither), never from a classifier or a stated topic, and
  // a scene never goes on a layout's shelf: the store front splits the two
  // before it shows any shelf (docs/scene-store.md "Categories").
  kind: "scene" | "layout";
  // Titles this category had before, which a scene's settings.category may
  // still say (a scene installed or forked from an older version).
  formerTitles?: string[];
};

export const storeCategories: StoreCategory[] = [
  {
    slug: "photos",
    title: "Photos",
    description:
      "Your own pictures on the frame: albums, slideshows, and photo services like Google Photos or Immich.",
    hint: "displays the user's own photos or photos fetched from a photo service (Google Photos, Immich, Unsplash, SD card, image URLs, slideshows)",
    kind: "scene",
  },
  {
    slug: "art",
    title: "Art & galleries",
    description:
      "Curated image collections that rotate on a schedule, no configuration needed.",
    hint: "a bundled, curated collection of artwork or themed images that ships with the scene and rotates through them",
    kind: "scene",
  },
  {
    slug: "clocks",
    title: "Clocks & time",
    description: "Clocks of every kind, timers and the year at a glance.",
    hint: "shows the time or counts time: clocks, word clocks, timers, pomodoro, countdowns, year or life progress",
    kind: "scene",
  },
  {
    slug: "calendar",
    title: "Calendars & agendas",
    description: "Upcoming events and schedules, straight from your calendar.",
    hint: "shows calendar events, agendas, or schedules (iCal, Google Calendar, day planners)",
    kind: "scene",
  },
  {
    slug: "weather",
    title: "Weather",
    description: "Current conditions and forecasts at a glance.",
    hint: "shows real weather conditions or forecasts",
    kind: "scene",
  },
  {
    slug: "dashboards",
    title: "Home & dashboards",
    description:
      "Smart home remotes, maps, charts and stats from the services you care about.",
    hint: "renders data, charts, maps, metrics or stats pulled from a service or API, or controls a smart home (Home Assistant, Homey)",
    kind: "scene",
    formerTitles: ["Data & dashboards"],
  },
  {
    slug: "games",
    title: "Games",
    description:
      "Puzzles, card and board games for a touch screen, and arcade games for a fast one.",
    hint: "a game the viewer plays: puzzles, card and board games, arcade games",
    kind: "scene",
  },
  {
    slug: "fun",
    title: "Fun & animations",
    description: "Comics, toys and animations that make you smile.",
    hint: "entertainment that is not a game: comics, jokes, novelty content, animations and visual toys",
    kind: "scene",
    formerTitles: ["Fun & comics", "Real time"],
  },
  {
    slug: "utilities",
    title: "Notes & tools",
    description:
      "To-dos, notes, drawing, and practical helpers like webcams and web page screenshots.",
    hint: "a practical tool the viewer uses: to-do lists, chores, notes, drawing, calculators, message boards, webcam/RTSP feeds, web page screenshots, file downloads",
    kind: "scene",
    formerTitles: ["Tools & utilities"],
  },
  {
    slug: "ai",
    title: "AI & generative",
    description:
      "Scenes that generate fresh images or words with AI on every refresh.",
    hint: "calls a generative AI service (OpenAI, image generation, LLM text) to produce the content it displays",
    kind: "scene",
  },
  {
    slug: "demos",
    title: "Demos & examples",
    description:
      "Small demos, made-up data and test patterns to learn from or remix.",
    hint: "primarily a demo, sample, test pattern or building block showing a FrameOS technique, often with made-up data, rather than a finished scene",
    kind: "scene",
  },
  {
    slug: "desktops",
    title: "Multi app layouts",
    description:
      "Desktops that run the frame's scenes side by side, in windows or tiles.",
    hint: "a desktop layout (settings.desktop): a layout that runs the frame's other scenes side by side in windows, tiles or panels, rather than showing anything of its own",
    kind: "layout",
    formerTitles: ["Desktop layouts"],
  },
  {
    slug: "layouts",
    title: "Single app layouts",
    description:
      "Title bars, status lines and picture frames drawn around the one scene that is showing.",
    hint: "a full screen layout: a scene that draws chrome around the one scene showing through a yield, rather than showing anything of its own",
    kind: "layout",
    formerTitles: ["Full screen layouts"],
  },
  {
    slug: "devices",
    title: "Device layouts",
    description:
      "Made for one device: what its keys do, written beside them, and its touch screen, battery and signal looked after.",
    hint: "a layout made for one device (settings.devices), drawn around its keys, screen and sensors",
    kind: "layout",
  },
];

// Slugs a category had before (2026-11-18: the Real time shelf became the
// store's "fast screen" need, docs/scene-store.md "What a scene needs"). A
// frame's store app from before asks for them by name.
export const formerCategorySlugs: Record<string, string> = {
  realtime: "fun",
};

/** The shelves that hold scenes, in shelf order. */
export const sceneCategories = storeCategories.filter((category) => category.kind === "scene");

/** The shelves that hold layouts: desktops, full screen, then the ones made for a device. */
export const layoutCategories = storeCategories.filter((category) => category.kind === "layout");

/** The shelf a layout goes on: by what it is, never by what it says. One made
 * for a device (`settings.devices`) goes on Device layouts, a desktop or not. */
export function layoutCategorySlug(desktop: boolean, forDevice = false): string {
  return forDevice ? "devices" : desktop ? "desktops" : "layouts";
}

export function isLayoutCategory(slug: string | null | undefined): boolean {
  return !!slug && layoutCategories.some((category) => category.slug === slug);
}

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
  return bySlug.has(slug) ? slug : formerCategorySlugs[slug];
}

// A scene names its category by the store's title ("Photos", "Clocks & time";
// settings.category, docs/scene-icons.md "Category"). The slug of the store
// category with that title, or undefined when it is none of them.
export function categorySlugForTitle(title: unknown): string | undefined {
  if (typeof title !== "string") {
    return undefined;
  }
  const name = title.trim();
  return storeCategories.find(
    (category) => category.title === name || category.formerTitles?.includes(name),
  )?.slug;
}
