// Photos share links inside scene JSON (docs/photos.md "Share links").
//
// A share link is a bearer credential for a whole album, and an album scene
// carries one as a plain string in its photoAlbum node's config. Anything
// that hands the scene to someone else hands them the album, so the store
// refuses to expose a scene that holds one (store-photo-links.ts) and the
// scene AI never sends one to the model: it sees a placeholder, and the
// placeholder turns back into the link in whatever the model returns.
//
// A link is recognized by the share route's path and its token, whatever is
// in front: absolute with any host (the cloud's, another backend's) or
// root-relative (the self-hosted backend writes `/api/photos/shared/pk_...`
// and the SPA adds the frame's server address). A bare `pk_...` is not a
// link: Stripe publishable keys look the same. Slashes may come escaped
// (`\/` in JSON inside a string, `%2F` in a query parameter).
//
// Pure, no imports. scripts/report-photo-links.mjs and the backend
// (app/utils/photo_share_links.py) carry copies of the pattern: keep them in
// step.

const slash = String.raw`(?:\\*\/|%2[Ff])`;
const tokenChars = "A-Za-z0-9_-";
const linkSource = `${slash}api${slash}photos${slash}shared${slash}(pk_[${tokenChars}]{32,128})(?![${tokenChars}])`;

// Not inside a longer word, except right after an escaped slash (`%2F`).
const wordStart = `(?:(?<=%2[Ff])|(?<![${tokenChars}]))`;

// What the model sees instead of a token: `pk_photo_link_1`, … — short
// enough that it is never mistaken for a token itself.
const placeholderPrefix = "pk_photo_link_";
const placeholderPattern = new RegExp(
  `${wordStart}${placeholderPrefix}(\\d{1,6})(?![${tokenChars}])`,
  "g",
);
const tokenPattern = new RegExp(`${wordStart}pk_[${tokenChars}]{32,128}(?![${tokenChars}])`, "g");

function linkPattern(flags = "") {
  return new RegExp(linkSource, flags);
}

/** True when any string in `value` (keys included, at any depth) holds a
 *  Photos share link. */
export function hasPhotoShareLink(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return typeof text === "string" && text.includes("pk_") && linkPattern().test(text);
}

/** The distinct share tokens linked from `value`, in order of appearance. */
export function photoShareTokens(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string" || !text.includes("pk_")) {
    return [];
  }
  return [...new Set([...text.matchAll(linkPattern("g"))].map((match) => match[1]!))];
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") {
    return map(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapStrings(item, map);
      changed ||= mapped !== item;
      return mapped;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const mappedKey = map(key);
      const mapped = mapStrings(item, map);
      changed ||= mappedKey !== key || mapped !== item;
      next[mappedKey] = mapped;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * One chat turn's swap of share tokens for placeholders. Each distinct token
 * gets the next number the first time it is seen, and keeps it for the rest
 * of the turn, so a link the model reads in the scene and again in a tool
 * result is the same placeholder both times. Only the token is swapped: the
 * host and the path stay, so the model still sees an album link.
 */
export class PhotoLinkRedactor {
  private readonly numbers = new Map<string, number>();
  private readonly tokens: string[] = [];

  /** How many distinct links this turn has hidden so far. */
  get size(): number {
    return this.tokens.length;
  }

  redactText(text: string): string {
    if (!text.includes("pk_")) {
      return text;
    }
    for (const match of text.matchAll(linkPattern("g"))) {
      const token = match[1]!;
      if (!this.numbers.has(token)) {
        this.tokens.push(token);
        this.numbers.set(token, this.tokens.length);
      }
    }
    if (this.tokens.length === 0) {
      return text;
    }
    // Every known token goes, also where it appears without the path (a log
    // line that printed the token on its own, a link split over two fields).
    return text.replace(tokenPattern, (token) => {
      const number = this.numbers.get(token);
      return number === undefined ? token : `${placeholderPrefix}${number}`;
    });
  }

  restoreText(text: string): string {
    if (this.tokens.length === 0 || !text.includes(placeholderPrefix)) {
      return text;
    }
    return text.replace(placeholderPattern, (placeholder, number: string) => {
      return this.tokens[Number(number) - 1] ?? placeholder;
    });
  }

  /** `value` with every string (and key) redacted; the same object back when
   *  nothing in it changed. Plain JSON values only: anything else is kept. */
  redact<T>(value: T): T {
    return mapStrings(value, (text) => this.redactText(text)) as T;
  }

  restore<T>(value: T): T {
    return mapStrings(value, (text) => this.restoreText(text)) as T;
  }
}
