// A scene whose state takes a latitude and a longitude (a weather scene,
// flights above me) gets a locate button on the first of the two in every
// state form: the browser's own location fills both. Shared by the SPA's
// forms (StateFieldEdit's callers) and the store's live preview.

export interface GeoLocation {
  latitude: number
  longitude: number
}

const latitudeNames = new Set(['latitude', 'lat'])
const longitudeNames = new Set(['longitude', 'lon', 'lng', 'long'])
// The types drawn as a text box; a select or a JSON field is not a coordinate.
const coordinateTypes = new Set(['string', 'float', 'integer', undefined])

/** The scene's latitude and longitude fields when it has both, and which
 * of the two comes first in the form (the one that carries the button). */
export function locationFieldPair<T extends { name: string; type?: string | undefined }>(
  fields: readonly T[]
): { latitude: T; longitude: T; first: string } | null {
  const usable = fields.filter((field) => coordinateTypes.has(field.type))
  const latitude = usable.find((field) => latitudeNames.has(field.name.toLowerCase()))
  const longitude = usable.find((field) => longitudeNames.has(field.name.toLowerCase()))
  if (!latitude || !longitude) {
    return null
  }
  return {
    latitude,
    longitude,
    first: fields.indexOf(latitude) < fields.indexOf(longitude) ? latitude.name : longitude.name,
  }
}

/** A coordinate as the field holds it: a number for a number field, text
 * otherwise. Five decimals is about a metre. */
export function coordinateValue(field: { type?: string | undefined }, coordinate: number): number | string {
  const rounded = Math.round(coordinate * 100000) / 100000
  return field.type === 'float' ? rounded : field.type === 'integer' ? Math.round(coordinate) : String(rounded)
}

/** The values a located position sets, by field name. */
export function locatedValues(
  pair: {
    latitude: { name: string; type?: string | undefined }
    longitude: { name: string; type?: string | undefined }
  },
  location: GeoLocation
): Record<string, number | string> {
  return {
    [pair.latitude.name]: coordinateValue(pair.latitude, location.latitude),
    [pair.longitude.name]: coordinateValue(pair.longitude, location.longitude),
  }
}

/** The browser's location (it asks the user the first time). Browsers
 * share it only with secure pages: a frame's own admin or a backend opened
 * over plain HTTP on the LAN gets a refusal that is not the user's. */
export function currentLocation(): Promise<GeoLocation> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      reject(new Error('Browsers share your location only with pages opened over HTTPS. Type the coordinates instead.'))
      return
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('This browser cannot tell your location.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      (error) => reject(new Error(geolocationErrorMessage(error))),
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 20000 }
    )
  })
}

export function geolocationErrorMessage(error: { code: number; message?: string }): string {
  if (error.code === 1) {
    return 'Location access was denied. Allow it for this site in the browser to use your location.'
  }
  if (error.code === 3) {
    return 'Finding your location took too long. Try again.'
  }
  return 'Your location is not available right now.'
}
