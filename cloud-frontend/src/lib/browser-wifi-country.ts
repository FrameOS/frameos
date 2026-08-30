// A best-effort default for the SD builder's "WiFi country" field: the region
// of the browser's locale ("fr-FR" → "FR"). It is only a prefill — a Belgian
// with an en-US browser gets "US", which is why the field stays editable and
// why a wrong guess is harmless: the regulatory domain only decides which
// channels the radio may join, and every domain includes channels 1-11.
export function browserWifiCountry(): string {
  try {
    const languages =
      typeof navigator === 'undefined'
        ? []
        : [...(navigator.languages ?? []), navigator.language].filter((tag): tag is string => typeof tag === 'string')
    for (const tag of languages) {
      const region = tag.split(/[-_]/)[1]
      if (region && /^[A-Za-z]{2}$/.test(region)) {
        return region.toUpperCase()
      }
    }
  } catch {
    // navigator is off limits (SSR, a locked-down context): no prefill.
  }
  return ''
}
