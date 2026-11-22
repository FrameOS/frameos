/**
 * Image formats the ESP32 firmware has no decoder for: it is built without
 * pixie's QOI and PPM codecs (`embedded/esp32/build_nim.sh`). A path field's
 * extension list offers them on a Pi, never on an ESP32.
 */
export const ESP32_UNDECODED_EXTENSIONS = ['qoi', 'ppm']

/** A path field's extensions as the frame's picker offers them. */
export function extensionsForFrame(extensions: string[] | undefined, esp32: boolean): string[] | undefined {
  if (!esp32 || !extensions || extensions.length === 0) {
    return extensions
  }
  return extensions.filter(
    (extension) => !ESP32_UNDECODED_EXTENSIONS.includes(extension.replace(/^\.+/, '').toLowerCase())
  )
}
