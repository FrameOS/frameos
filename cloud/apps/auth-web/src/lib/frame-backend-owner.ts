// A cloud ESP32 can have a self-hosted backend set on it as well (`set
// backend` on its console, a bench setup). The backend then owns the frame's
// content: the device refuses every content verb `backend_managed`
// (fos_cloud.c) and reports the backend's origin as `hardware.backend` on
// every hello. docs/cloud-frames.md "While managed".

/** The backend origin the frame reported, or null when it reported none. */
export function frameOwningBackend(hardware: unknown): string | null {
  if (!hardware || typeof hardware !== "object" || Array.isArray(hardware)) {
    return null;
  }
  const value = (hardware as Record<string, unknown>).backend;
  if (typeof value !== "string") {
    return null;
  }
  const backend = value.trim().slice(0, 256);
  return backend ? backend : null;
}
