// The IANA zone of the browser adding a frame — the best available guess for
// where the frame will hang, and the one thing a fresh board cannot know on
// its own. Every claim-token mint sends it (enrollment seeds the frame's
// `timezone` setting from it), the ESP32 flasher also writes it over serial
// and the SD image builder bakes it into the image, so a new frame shows
// local time instead of UTC until someone debugs it. Validated to the shape
// the console's `set time_zone` and the cloud setting accept.
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return undefined
    return /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(zone) ? zone : undefined
  } catch {
    return undefined
  }
}

// The claim-token mint body fragment: `{ timezone }` when the browser has a
// usable zone, nothing otherwise.
export function claimTokenTimeZoneFields(): { timezone?: string } {
  const timezone = browserTimeZone()
  return timezone ? { timezone } : {}
}
