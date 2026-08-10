// FrameOS versions are CalVer-ish dotted numbers ("2026.8.0", sometimes with a
// trailing suffix like "2026.8.0-rc1"). They must never be compared as
// strings: "2026.10.0" sorts BEFORE "2026.9.0" lexicographically, which would
// hide every scene published after the ninth release of a year.
//
// Every comparison in the store goes through the key below: the numeric prefix
// of the version, split on ".", zero-padded to a fixed width, compared element
// by element. The Postgres expression further down does the same thing on the
// server so paginated listings and the JSON repository agree.

export const frameosVersionComponents = 4;
const numericPrefix = /^[0-9]+(?:\.[0-9]+)*/;

// Parsed form of a FrameOS version: exactly `frameosVersionComponents` numbers.
// undefined means "not a version we can reason about" (empty, or something
// like "nightly"), which callers treat as "no declared requirement".
export function frameosVersionKey(
  value: string | null | undefined,
): number[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = numericPrefix.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const parts = match[0].split(".").slice(0, frameosVersionComponents);
  const key = parts.map((part) => {
    const parsed = Number.parseInt(part, 10);
    // Absurdly long components would lose precision as doubles; clamp instead
    // of producing NaN so ordering stays total.
    return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  });
  while (key.length < frameosVersionComponents) {
    key.push(0);
  }
  return key;
}

// -1 / 0 / 1, comparing the numeric components. Unparseable versions sort
// before everything else so they never look "too new".
export function compareFrameosVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const keyA = frameosVersionKey(a);
  const keyB = frameosVersionKey(b);
  if (!keyA || !keyB) {
    return keyA ? 1 : keyB ? -1 : 0;
  }
  for (let index = 0; index < frameosVersionComponents; index += 1) {
    const diff = (keyA[index] ?? 0) - (keyB[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

// Does a scene declaring `minimum` as its minimum FrameOS version run on
// `target`? A scene with no (or an unreadable) declared minimum is assumed to
// run anywhere — we cannot prove otherwise, and hiding it would be worse than
// showing it. Same for an unreadable target.
export function frameosVersionSatisfies(
  minimum: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const minimumKey = frameosVersionKey(minimum);
  const targetKey = frameosVersionKey(target);
  if (!minimumKey || !targetKey) {
    return true;
  }
  return compareFrameosVersions(minimum, target) <= 0;
}

// Newest first, for version pickers.
export function sortFrameosVersionsDesc(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => compareFrameosVersions(b, a));
}

// Path segment / query value form. Deliberately stricter than the manifest
// validation in store.ts: this is a version somebody is filtering by, so it
// must be a plain dotted number ("2026.8.0"), never "nightly" or "v3".
const requestedVersionPattern = /^[0-9]{1,10}(?:\.[0-9]{1,10}){0,3}$/;

export function normalizeRequestedFrameosVersion(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return requestedVersionPattern.test(trimmed) ? trimmed : undefined;
}
