// Shared error copy for /api/frames/firmware lookups (ESP32 flasher and SD
// image builder). The route proxies api.github.com, so by far the most common
// failure is GitHub itself being down or rate limiting — say that instead of
// a bare "Release lookup failed (502)", while keeping the status code visible
// for bug reports.
export function releaseLookupErrorMessage(status: number, code?: string): string {
  if (code === "release_lookup_failed" || status === 502 || status === 503 || status === 504) {
    return (
      "GitHub seems to be having trouble right now — FrameOS releases are hosted there, " +
      `and the release lookup did not get through (HTTP ${status}` +
      `${code ? `, ${code}` : ""}). It usually recovers on its own; try again in a few minutes.`
    );
  }
  if (status === 429) {
    return `The release lookup is being rate limited (HTTP 429). Wait a minute and try again.`;
  }
  if (status === 401) {
    return "Your session expired — sign in again and retry.";
  }
  return `Could not look up the latest FrameOS release (HTTP ${status}${code ? `, ${code}` : ""}). Try again in a moment.`;
}

// Fetch + decode helper so both components fail with the same message.
export async function fetchReleaseListing<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(releaseLookupErrorMessage(response.status, detail.error));
  }
  return (await response.json()) as T;
}
